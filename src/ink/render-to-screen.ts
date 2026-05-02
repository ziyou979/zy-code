import noop from 'lodash-es/noop.js'
import type { ReactElement } from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { createNode, type DOMElement } from './dom.js'
import { FocusManager } from './focus.js'
import Output from './output.js'
import reconciler from './reconciler.js'
import renderNodeToOutput, { resetLayoutShifted } from './render-node-to-output.js'
import {
  CellWidth,
  CharPool,
  cellAtIndex,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
  setCellStyleId,
} from './screen.js'

/** 匹配项在渲染消息中的位置，相对于消息自身的
 *  边界框（第 0 行 = 消息顶部）。滚动时保持稳定——
 *  要在真实屏幕上高亮，需加上消息的 screen-row 偏移。 */
export type MatchPosition = {
  row: number
  col: number
  /** 匹配跨越的 CELL 数量（ASCII 查询 = query.length，
   *  包含宽字符时更多）。 */
  len: number
}

// 多次调用之间共享。Pool 会积累 style/char 的缓存——复用它们
// 能让后续调用更多地命中缓存。Root/container 复用可节省
// createContainer 开销（约 1ms）。LegacyRoot：所有工作同步执行，无调度——
// ConcurrentRoot 的调度器积压会通过 flushSyncWork 在 root 之间泄漏。
let root: DOMElement | undefined
let container: ReturnType<typeof reconciler.createContainer> | undefined
let stylePool: StylePool | undefined
let charPool: CharPool | undefined
let hyperlinkPool: HyperlinkPool | undefined
let output: Output | undefined

const timing = { reconcile: 0, yoga: 0, paint: 0, scan: 0, calls: 0 }
const LOG_EVERY = 20

/** 将 React 元素（由调用者包装好组件所需的全部上下文）
 *  渲染到指定宽度的独立 Screen 缓冲区。返回 Screen + 自然高度
 *  （来自 yoga）。用于搜索：渲染单条消息，扫描其 Screen 查找关键词，
 *  获取精确的 (row, col) 位置。
 *
 *  每次调用约 1-3ms（yoga 分配 + calculateLayout + 绘制）。
 *  flushSyncWork 的跨 root 泄漏测量显示每次调用增长约 0.0003ms——
 *  按需渲染单条消息可以接受，但预先渲染全部 8k 条会非常糟糕。
 *  在上游按 (msg, query, width) 做缓存。
 *
 *  每次调用之间会卸载。Root/container/pool 会保留以供复用。 */
export function renderToScreen(
  el: ReactElement,
  width: number,
): { screen: Screen; height: number } {
  if (!root) {
    root = createNode('ink-root')
    root.focusManager = new FocusManager(() => false)
    stylePool = new StylePool()
    charPool = new CharPool()
    hyperlinkPool = new HyperlinkPool()
    container = (reconciler as any).createContainer(
      root,
      LegacyRoot,
      null,
      false,
      null,
      'search-render',
      noop,
      noop,
      noop,
      noop,
    ) as any
  }

  const reconcileStartMs = performance.now()
  reconciler.updateContainerSync(el, container, null, noop)
  reconciler.flushSyncWork()
  const reconcileEndMs = performance.now()

  // Yoga 布局。如果树为空，root 可能没有 yogaNode。
  root.yogaNode?.setWidth(width)
  root.yogaNode?.calculateLayout(width)
  const height = Math.ceil(root.yogaNode?.getComputedHeight() ?? 0)
  const layoutEndMs = performance.now()

  // 绘制到全新的 Screen。宽度 = 给定值，高度 = yoga 计算的自然高度。
  // 无 alt-screen，无 prevScreen（每次调用都是全新的）。
  const screen = createScreen(
    width,
    Math.max(1, height), // 避免高度为 0 的 Screen（createScreen 可能出错）
    stylePool!,
    charPool!,
    hyperlinkPool!,
  )
  if (!output) {
    output = new Output({ width, height, stylePool: stylePool!, screen })
  } else {
    output.reset(width, height, screen)
  }
  resetLayoutShifted()
  renderNodeToOutput(root, output, { prevScreen: undefined })
  // renderNodeToOutput 将写入排队到 Output；.get() 将队列
  // 刷新到 Screen 的 cell 数组。不执行此步则屏幕为空
  // （构造时为零）。
  const rendered = output.get()
  const paintEndMs = performance.now()

  // 卸载以便下次调用获得全新的树。保留 root/container/pool。
  reconciler.updateContainerSync(null, container, null, noop)
  reconciler.flushSyncWork()

  timing.reconcile += reconcileEndMs - reconcileStartMs
  timing.yoga += layoutEndMs - reconcileEndMs
  timing.paint += paintEndMs - layoutEndMs
  if (++timing.calls % LOG_EVERY === 0) {
    const total = timing.reconcile + timing.yoga + timing.paint + timing.scan
    logForDebugging(
      `renderToScreen: ${timing.calls} calls · ` +
        `reconcile=${timing.reconcile.toFixed(1)}ms yoga=${timing.yoga.toFixed(1)}ms ` +
        `paint=${timing.paint.toFixed(1)}ms scan=${timing.scan.toFixed(1)}ms · ` +
        `total=${total.toFixed(1)}ms · avg ${(total / timing.calls).toFixed(2)}ms/call`,
    )
  }

  return { screen: rendered, height }
}

/** 扫描 Screen 缓冲区查找 query 的所有出现位置。返回相对于
 *  缓冲区的位置（第 0 行 = 缓冲区顶部）。使用与 applySearchHighlight
 *  （SpacerTail/SpacerHead/noSelect）相同的跳过 cell 逻辑，因此
 *  位置与覆盖高亮能匹配上。不区分大小写。
 *
 *  用于侧边渲染：此 Screen 是完整消息（自然高度，不被视口裁剪）。
 *  位置是稳定的——要在真实屏幕上高亮，加上消息的屏幕偏移（lo）。 */
export function scanPositions(screen: Screen, query: string): MatchPosition[] {
  const lq = query.toLowerCase()
  if (!lq) return []
  const qlen = lq.length
  const w = screen.width
  const h = screen.height
  const noSelect = screen.noSelect
  const positions: MatchPosition[] = []

  const scanStartMs = performance.now()
  for (let row = 0; row < h; row++) {
    const rowOff = row * w
    // 与 applySearchHighlight 相同的文本构建方式。保持同步——
    // 或提取为共享 helper（待两者都稳定后 TODO）。codeUnitToCell
    // 将 indexOf 位置（小写文本中的代码单元）映射到 colOf 中的 cell
    // 索引——代理对（emoji）和多单元小写（土耳其语 İ → i + U+0307）
    // 导致 text.length > colOf.length。
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
    // 不重叠——与 applySearchHighlight 相同的推进方式。
    let pos = text.indexOf(lq)
    while (pos >= 0) {
      const startCi = codeUnitToCell[pos]!
      const endCi = codeUnitToCell[pos + qlen - 1]!
      const col = colOf[startCi]!
      const endCol = colOf[endCi]! + 1
      positions.push({ row, col, len: endCol - col })
      pos = text.indexOf(lq, pos + qlen)
    }
  }
  timing.scan += performance.now() - scanStartMs

  return positions
}

/** 在 positions[currentIdx] + rowOffset 处写入 CURRENT 样式
 *  （黄色+加粗+下划线）。其他位置不在此处设置样式——
 *  搜索高亮（applySearchHighlight 使用 null hint）对所有可见
 *  匹配项做反色处理，包括这些。两层设计：scan = "你可以跳到这里"，
 *  position = "你当前在这里"。在此再写一次反色不会有问题
 *  （withInverse 幂等），但是多余工作。
 *
 *  位置是相对于消息的（第 0 行 = 消息顶部）。rowOffset =
 *  消息当前的屏幕顶部（lo）。会裁剪掉 [0, height) 范围外的部分。 */
export function applyPositionedHighlight(
  screen: Screen,
  stylePool: StylePool,
  positions: MatchPosition[],
  rowOffset: number,
  currentIdx: number,
): boolean {
  if (currentIdx < 0 || currentIdx >= positions.length) return false
  const p = positions[currentIdx]!
  const row = p.row + rowOffset
  if (row < 0 || row >= screen.height) return false
  const transform = (id: number) => stylePool.withCurrentMatch(id)
  const rowOff = row * screen.width
  for (let col = p.col; col < p.col + p.len; col++) {
    if (col < 0 || col >= screen.width) continue
    const cell = cellAtIndex(screen, rowOff + col)
    setCellStyleId(screen, col, row, transform(cell.styleId))
  }
  return true
}
