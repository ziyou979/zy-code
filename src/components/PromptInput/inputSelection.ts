import type { CachedLayout } from '../../ink/nodeCache.js'
import type { SelectionBounds } from '../../ink/selection.js'
import { Cursor } from '../../terminal-ui/cursor.js'

type InputSelectionOptions = {
  input: string
  columns: number
  cursorOffset: number
  maxVisibleLines?: number
  inputRect: CachedLayout
  bounds: SelectionBounds
}

/**
 * 将终端的闭区间单元格选区映射为输入字符串的半开偏移区间。
 *
 * 屏幕复制文本会丢失软换行信息，并可能混入提示符或行尾空白，
 * 因此删除不能依赖复制文本反查。这里复用输入框的 Cursor 换行模型，
 * 使点击定位、显示换行和拖选删除使用同一套宽字符/换行规则。
 */
export function getInputSelectionOffsets({
  input,
  columns,
  cursorOffset,
  maxVisibleLines,
  inputRect,
  bounds,
}: InputSelectionOptions): { start: number; end: number } | null {
  const rectX = Math.floor(inputRect.x)
  const rectY = Math.floor(inputRect.y)
  const rectHeight = Math.floor(inputRect.height)
  const lastRow = rectY + Math.max(0, rectHeight - 1)

  // 仅处理两个端点都落在输入框可见行内的选区；跨到历史区的选择不能改输入。
  if (
    rectHeight <= 0 ||
    bounds.start.row < rectY ||
    bounds.start.row > lastRow ||
    bounds.end.row < rectY ||
    bounds.end.row > lastRow
  ) {
    return null
  }

  const cursor = Cursor.fromText(input, columns, cursorOffset)
  const viewportStart = cursor.getViewportStartLine(maxVisibleLines)
  const start = cursor.measuredText.getOffsetFromPosition({
    line: bounds.start.row - rectY + viewportStart,
    column: Math.max(0, bounds.start.col - rectX),
  })
  const end = cursor.measuredText.getOffsetFromPosition({
    line: bounds.end.row - rectY + viewportStart,
    // 终端选区包含 end 单元格，而字符串删除区间不包含 end。
    column: Math.max(0, bounds.end.col - rectX + 1),
  })

  return start < end ? { start, end } : null
}
