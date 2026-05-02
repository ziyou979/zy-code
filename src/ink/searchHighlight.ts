import { CellWidth, cellAtIndex, type Screen, type StylePool, setCellStyleId } from './screen.js'

/**
 * 在屏幕缓冲区中反转为 `query` 匹配的所有可见单元格，
 * 通过反转单元格样式（SGR 7）实现高亮。渲染后，使用与
 * applySelectionOverlay 相同的损伤追踪机制——差异引擎会将
 * 高亮单元格视为普通变更，LogUpdate 保持为纯差异引擎。
 *
 * 不区分大小写。通过为每行构建字符到列的映射来处理宽字符
 *（CJK、emoji）——当存在宽字符时，第 N 个字符不在第 N 列
 *（每个宽字符占用 2 个单元格：head + SpacerTail）。
 *
 * 此函数只做反转——没有"当前匹配"逻辑。黄色当前匹配
 * 覆盖层由 applyPositionedHighlight（render-to-screen.ts）
 * 单独处理，它使用从目标消息 DOM 子树扫描的位置写入上层。
 *
 * 返回 true 表示有任何匹配被高亮（损伤门控——调用者在为 true 时
 * 强制全屏损伤）。
 */
export function applySearchHighlight(screen: Screen, query: string, stylePool: StylePool): boolean {
  if (!query) return false
  const lq = query.toLowerCase()
  const qlen = lq.length
  const w = screen.width
  const noSelect = screen.noSelect
  const height = screen.height

  let applied = false
  for (let row = 0; row < height; row++) {
    const rowOff = row * w
    // 构建行文本（已转小写）+ code-unit 到 cell 索引的映射。
    // 三个跳过条件，均与 setCellStyleId /
    // extractRowText（selection.ts）保持一致：
    //   - SpacerTail：宽字符的第 2 个单元格，没有自己的字符
    //   - SpacerHead：行尾填充，当宽字符换行时出现
    //   - noSelect：边栏（⎿、行号）——与
    //     applySelectionOverlay 排除相同。"高亮所见内容"
    //     对正文仍然成立；边栏不是搜索目标。
    // 逐字符转小写（而非最后对拼接字符串整体转小写），
    // 确保 codeUnitToCell 映射的是小写文本中的位置——
    // U+0130（土耳其语 İ）小写后变为 2 个 code unit，
    // 因此对拼接字符串转小写会导致 indexOf 位置与映射脱节。
    let text = ''
    const colOf: number[] = []
    const codeUnitToCell: number[] = []
    for (let col = 0; col < w; col++) {
      const idx = rowOff + col
      const cell = cellAtIndex(screen, idx)
      if (
        cell.width === CellWidth.SpacerTail ||
        cell.width === CellWidth.SpacerHead ||
        noSelect[idx] === 1
      ) {
        continue
      }
      const lc = cell.char.toLowerCase()
      const cellIdx = colOf.length
      for (let i = 0; i < lc.length; i++) {
        codeUnitToCell.push(cellIdx)
      }
      text += lc
      colOf.push(col)
    }

    let pos = text.indexOf(lq)
    while (pos >= 0) {
      applied = true
      const startCi = codeUnitToCell[pos]!
      const endCi = codeUnitToCell[pos + qlen - 1]!
      for (let ci = startCi; ci <= endCi; ci++) {
        const col = colOf[ci]!
        const cell = cellAtIndex(screen, rowOff + col)
        setCellStyleId(screen, col, row, stylePool.withInverse(cell.styleId))
      }
      // 非重叠步进（与 less/vim/grep/Ctrl+F 一致）。
      // pos+1 会在 'aaa' 中 0 和 1 位置都找到 'aa'，导致单元格 1 被双重反转。
      pos = text.indexOf(lq, pos + qlen)
    }
  }

  return applied
}
