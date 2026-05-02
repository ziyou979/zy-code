/**
 * Text selection state for fullscreen mode.
 *
 * Tracks a linear selection in screen-buffer coordinates (0-indexed col/row).
 * Selection is line-based: cells from (startCol, startRow) through
 * (endCol, endRow) inclusive, wrapping across line boundaries. This matches
 * terminal-native selection behavior (not rectangular/block).
 *
 * The selection is stored as ANCHOR (where the drag started) + FOCUS (where
 * the cursor is now). The rendered highlight normalizes to start ≤ end.
 */

import { clamp } from './layout/geometry.js'
import type { Screen, StylePool } from './screen.js'
import { CellWidth, cellAt, cellAtIndex, setCellStyleId } from './screen.js'

type Point = { col: number; row: number }

export type SelectionState = {
  /** Where the mouse-down occurred. Null when no selection. */
  anchor: Point | null
  /** Current drag position (updated on mouse-move while dragging). */
  focus: Point | null
  /** True between mouse-down and mouse-up. */
  isDragging: boolean
  /** For word/line mode: the initial word/line bounds from the first
   *  multi-click. Drag extends from this span to the word/line at the
   *  current mouse position so the original word/line stays selected
   *  even when dragging backward past it. Null ⇔ char mode. The kind
   *  tells extendSelection whether to snap to word or line boundaries. */
  anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null
  /** Text from rows that scrolled out ABOVE the viewport during
   *  drag-to-scroll. The screen buffer only holds the current viewport,
   *  so without this accumulator, dragging down past the bottom edge
   *  loses the top of the selection once the anchor clamps. Prepended
   *  to the on-screen text by getSelectedText. Reset on start/clear. */
  scrolledOffAbove: string[]
  /** Symmetric: rows scrolled out BELOW when dragging up. Appended. */
  scrolledOffBelow: string[]
  /** Soft-wrap bits parallel to scrolledOffAbove — true means the row
   *  is a continuation of the one before it (the `\n` was inserted by
   *  word-wrap, not in the source). Captured alongside the text at
   *  scroll time since the screen's softWrap bitmap shifts with content.
   *  getSelectedText uses these to join wrapped rows back into logical
   *  lines. */
  scrolledOffAboveSW: boolean[]
  /** Parallel to scrolledOffBelow. */
  scrolledOffBelowSW: boolean[]
  /** Pre-clamp anchor row. Set when shiftSelection clamps anchor so a
   *  reverse scroll can restore the true position and pop accumulators.
   *  Without this, PgDn (clamps anchor) → PgUp leaves anchor at the wrong
   *  row AND scrolledOffAbove stale — highlight ≠ copy. Undefined when
   *  anchor is in-bounds (no clamp debt). Cleared on start/clear. */
  virtualAnchorRow?: number
  /** Same for focus. */
  virtualFocusRow?: number
  /** True if the mouse-down that started this selection had the alt
   *  modifier set (SGR button bit 0x08). On macOS xterm.js this is a
   *  signal that VS Code's macOptionClickForcesSelection is OFF — if it
   *  were on, xterm.js would have consumed the event for native selection
   *  and we'd never receive it. Used by the footer to show the right hint. */
  lastPressHadAlt: boolean
}

export function createSelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

export function startSelection(s: SelectionState, col: number, row: number): void {
  s.anchor = { col, row }
  // Focus is not set until the first drag motion. A click-release with no
  // drag leaves focus null → hasSelection/selectionBounds return false/null
  // via the `!s.focus` check, so a bare click never highlights a cell.
  s.focus = null
  s.isDragging = true
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

export function updateSelection(s: SelectionState, col: number, row: number): void {
  if (!s.isDragging) return
  // First motion at the same cell as anchor is a no-op. Terminals in mode
  // 1002 can fire a drag event at the anchor cell (sub-pixel tremor, or a
  // motion-release pair). Setting focus here would turn a bare click into
  // a 1-cell selection and clobber the clipboard via useCopyOnSelect. Once
  // focus is set (real drag), we track normally including back to anchor.
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row) return
  s.focus = { col, row }
}

export function finishSelection(s: SelectionState): void {
  s.isDragging = false
  // Keep anchor/focus so highlight stays visible and text can be copied.
  // Clear via clearSelection() on Esc or after copy.
}

export function clearSelection(s: SelectionState): void {
  s.anchor = null
  s.focus = null
  s.isDragging = false
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

// Unicode-aware word character matcher: letters (any script), digits,
// and the punctuation set iTerm2 treats as word-part by default.
// Matching iTerm2's default means double-clicking a path like
// `/usr/bin/bash` or `~/.zy/config.json` selects the whole thing,
// which is the muscle memory most macOS terminal users have.
// iTerm2 default "characters considered part of a word": /-+\~_.
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

/**
 * Character class for double-click word-expansion. Cells with the same
 * class as the clicked cell are included in the selection; a class change
 * is a boundary. Matches typical terminal-emulator behavior (iTerm2 etc.):
 * double-click on `foo` selects `foo`, on `->` selects `->`, on spaces
 * selects the whitespace run.
 */
function charClass(c: string): 0 | 1 | 2 {
  if (c === ' ' || c === '') return 0
  if (WORD_CHAR.test(c)) return 1
  return 2
}

/**
 * 查找（col, row）处相同类别字符运行的边界。返回
 * null 如果点击超出边界或落在 noSelect 单元格上。由
 * selectWordAt（初始双击）和 extendWordSelection（拖拽）使用。
 */
function wordBoundsAt(screen: Screen, col: number, row: number): { lo: number; hi: number } | null {
  if (row < 0 || row >= screen.height) return null
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  // 如果点击落在宽字符的 spacer tail 上，回退到
  // head 以便类别检查看到实际的字素。
  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return null

  const startCell = cellAt(screen, c, row)
  if (!startCell) return null
  const cls = charClass(startCell.char)

  // 向左扩展：包含相同类别的单元格，在 noSelect 或
  // 类别变化处停止。跳过 SpacerTail 单元格（宽字符 head
  // 在前一列决定类别）。
  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc) break
    if (pc.width === CellWidth.SpacerTail) {
      // 跳过 spacer 到宽字符 head
      if (prev === 0 || noSelect[rowOff + prev - 1] === 1) break
      const head = cellAt(screen, prev - 1, row)
      if (!head || charClass(head.char) !== cls) break
      lo = prev - 1
      continue
    }
    if (charClass(pc.char) !== cls) break
    lo = prev
  }

  // 向右扩展：相同逻辑，跳过 spacer tail。
  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc) break
    if (nc.width === CellWidth.SpacerTail) {
      // 将 spacer tail 包含在选择范围内（它属于
      // hi 处的宽字符）并继续越过它。
      hi = next
      continue
    }
    if (charClass(nc.char) !== cls) break
    hi = next
  }

  return { lo, hi }
}

/** -1 如果 a < b，1 如果 a > b，0 如果相等（阅读顺序：先行后列）。 */
function comparePoints(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return 0
}

/**
 * 通过扫描屏幕缓冲区选择（col, row）处的单词，
 * 查找相同类别字符运行的边界。就地修改选择。
 * 如果点击超出边界或落在 noSelect 单元格上则无操作。
 * 设置 isDragging=true 和 anchorSpan 以便后续拖拽逐字扩展
 * 选择（macOS 原生行为）。
 */
export function selectWordAt(s: SelectionState, screen: Screen, col: number, row: number): void {
  const b = wordBoundsAt(screen, col, row)
  if (!b) return
  const lo = { col: b.lo, row }
  const hi = { col: b.hi, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'word' }
}

// 可打印 ASCII 减去终端 URL 分隔符。限制为单代码单元
// ASCII 保持单元格数 === 字符串索引，所以下方的列跨度
// 检查是精确的（无宽字符/字素偏移）。
const URL_BOUNDARY = new Set([...'<>"\'` '])
function isUrlChar(c: string): boolean {
  if (c.length !== 1) return false
  const code = c.charCodeAt(0)
  return code >= 0x21 && code <= 0x7e && !URL_BOUNDARY.has(c)
}

/**
 * 扫描屏幕缓冲区查找（col, row）处的纯文本 URL。镜像
 * 终端的原生 Cmd+Click URL 检测，全屏模式的鼠标
 * 跟踪会拦截它。从 getHyperlinkAt 调用作为回退，
 * 当单元格没有 OSC 8 hyperlink 时。
 */
export function findPlainTextUrlAt(screen: Screen, col: number, row: number): string | undefined {
  if (row < 0 || row >= screen.height) return undefined
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return undefined

  const startCell = cellAt(screen, c, row)
  if (!startCell || !isUrlChar(startCell.char)) return undefined

  // 向左/向右扩展到 URL 字符运行的边界。URL 是 ASCII
  //（CellWidth.Narrow，1 代码单元），所以遇到非 ASCII/宽/spacer
  // 单元格就是边界 — 无需像 wordBoundsAt 那样跳过 spacer。
  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc || pc.width !== CellWidth.Narrow || !isUrlChar(pc.char)) break
    lo = prev
  }
  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc || nc.width !== CellWidth.Narrow || !isUrlChar(nc.char)) break
    hi = next
  }

  let token = ''
  for (let i = lo; i <= hi; i++) token += cellAt(screen, i, row)!.char

  // 1 单元格 = 1 字符在 [lo, hi] 范围内（仅 ASCII 运行），所以字符串索引 =
  // 列偏移。查找点击处或之前的最后一个 scheme 锚点 —
  // 像 `https://a.com,https://b.com` 这样的运行有两个，点击
  // 第二个应该返回第二个 URL，而不是贪婪匹配两者。
  const clickIdx = c - lo
  const schemeRe = /(?:https?|file):\/\//g
  let urlStart = -1
  let urlEnd = token.length
  for (let m; (m = schemeRe.exec(token)); ) {
    if (m.index > clickIdx) {
      urlEnd = m.index
      break
    }
    urlStart = m.index
  }
  if (urlStart < 0) return undefined
  let url = token.slice(urlStart, urlEnd)

  // 去除尾部句子标点。对于闭合符 () ] }，仅在不平衡时去除
  // — `/wiki/Foo_(bar)` 保留 `)`，`/arr[0]` 保留 `]`。
  const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  while (url.length > 0) {
    const last = url.at(-1)!
    if ('.,;:!?'.includes(last)) {
      url = url.slice(0, -1)
      continue
    }
    const opener = OPENER[last]
    if (!opener) break
    let opens = 0
    let closes = 0
    for (let i = 0; i < url.length; i++) {
      const ch = url.charAt(i)
      if (ch === opener) opens++
      else if (ch === last) closes++
    }
    if (closes > opens) url = url.slice(0, -1)
    else break
  }

  // urlStart 已经保证点击 >= URL 起始；检查右边缘。
  if (clickIdx >= urlStart + url.length) return undefined

  return url
}

/**
 * 选择整行。设置 isDragging=true 和 anchorSpan 以便
 * 后续拖拽逐行扩展选择。anchor/focus
 * 跨越从列 0 到 width-1；getSelectedText 处理 noSelect 跳过
 * 和尾部空白修剪，以便复制的文本只是可见的
 * 行内容。
 */
export function selectLineAt(s: SelectionState, screen: Screen, row: number): void {
  if (row < 0 || row >= screen.height) return
  const lo = { col: 0, row }
  const hi = { col: screen.width - 1, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'line' }
}

/**
 * 将字/行模式选择扩展到（col, row）处的字/行。
 * anchor span（最初多次点击的字/行）保持选中；
 * 选择从该 span 增长到当前鼠标位置的字/行。
 * 当鼠标在 noSelect 单元格上或超出边界时，字模式回退到原始单元格，
 * 所以拖拽到装订线仍然扩展。
 */
export function extendSelection(s: SelectionState, screen: Screen, col: number, row: number): void {
  if (!s.isDragging || !s.anchorSpan) return
  const span = s.anchorSpan
  let mLo: Point
  let mHi: Point
  if (span.kind === 'word') {
    const b = wordBoundsAt(screen, col, row)
    mLo = { col: b ? b.lo : col, row }
    mHi = { col: b ? b.hi : col, row }
  } else {
    const r = clamp(row, 0, screen.height - 1)
    mLo = { col: 0, row: r }
    mHi = { col: screen.width - 1, row: r }
  }
  if (comparePoints(mHi, span.lo) < 0) {
    // 鼠标目标在 anchor span 之前结束：向后扩展。
    s.anchor = span.hi
    s.focus = mLo
  } else if (comparePoints(mLo, span.hi) > 0) {
    // 鼠标目标在 anchor span 之后开始：向前扩展。
    s.anchor = span.lo
    s.focus = mHi
  } else {
    // 鼠标覆盖 anchor span：只选择 anchor span。
    s.anchor = span.lo
    s.focus = span.hi
  }
}

/** 语义键盘焦点移动。见 ink.tsx 中的 moveSelectionFocus 了解
 *  如何应用屏幕边界 + 行换行。 */
export type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd'

/**
 * 设置焦点到（col, row）用于键盘选择扩展（shift+arrow）。
 * Anchor 保持固定；选择根据焦点相对于 anchor 的
 * 移动位置增长或缩小。下降到字符模式（清除 anchorSpan）—
 * 原生 macOS 也这样做：双击字选择后的 shift+arrow
 * 从字边缘逐字符扩展，而不是逐字。滚动离开
 * 的累加器保留：键盘扩展拖拽滚动的选择
 * 保留屏幕外的行。调用者提供已钳位/换行的坐标。
 */
export function moveFocus(s: SelectionState, col: number, row: number): void {
  if (!s.focus) return
  s.anchorSpan = null
  s.focus = { col, row }
  // 显式用户重新定位 — 任何陈旧的虚拟焦点（来自之前的
  // shiftSelection 钳位）不再反映意图。Anchor 保持不动所以
  // virtualAnchorRow 对其自身的往返仍然有效。
  s.virtualFocusRow = undefined
}

/**
 * 将 anchor 和 focus 都移动 dRow，钳位到 [minRow, maxRow]。
 * 用于键盘滚动（PgUp/PgDn/ctrl+u/d/b/f）：整个选择必须跟随
 * 内容移动，与拖拽滚动不同（焦点保持在鼠标处）。
 * 任何碰到钳位边界的点都会将列重置为全宽边缘 —
 * 其原始内容已滚动到屏幕外并被 captureScrolledRows 捕获，
 * 所以列约束已被消费。保留它会截断现在在该屏幕行的
 * 新内容。钳位列在 dRow<0 时为 0（向下滚动，顶部离开，
 * 'above' 语义）或 dRow>0 时为 width-1（向上滚动，底部离开，
 * 'below' 语义）。
 *
 * 如果两端都超出相同的视口边缘（选择文本 → Home/End/g/G
 * 跳跃足够远使得两者都超出视图），清除 — 否则两者都钳位
 * 到同一个角单元格，幽灵 1 单元格高亮残留，
 * getSelectedText 从该角返回一个不相关的字符。与
 * shiftSelectionForFollow 的顶部边缘检查对称，但是双向的：
 * 键盘滚动可以跳转任一方向。
 */
export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return
  // Virtual rows track pre-clamp positions so reverse scrolls restore
  // correctly. Without this, clamp(5→0) + shift(+10) = 10, not the true 5,
  // and scrolledOffAbove stays stale (highlight ≠ copy).
  const vAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const vFocus = (s.virtualFocusRow ?? s.focus.row) + dRow
  if ((vAnchor < minRow && vFocus < minRow) || (vAnchor > maxRow && vFocus > maxRow)) {
    clearSelection(s)
    return
  }
  // Debt = how far the nearer endpoint overshoots each edge. When debt
  // shrinks (reverse scroll), those rows are back on-screen — pop from
  // the accumulator so getSelectedText doesn't double-count them.
  const oldMin = Math.min(s.virtualAnchorRow ?? s.anchor.row, s.virtualFocusRow ?? s.focus.row)
  const oldMax = Math.max(s.virtualAnchorRow ?? s.anchor.row, s.virtualFocusRow ?? s.focus.row)
  const oldAboveDebt = Math.max(0, minRow - oldMin)
  const oldBelowDebt = Math.max(0, oldMax - maxRow)
  const newAboveDebt = Math.max(0, minRow - Math.min(vAnchor, vFocus))
  const newBelowDebt = Math.max(0, Math.max(vAnchor, vFocus) - maxRow)
  if (newAboveDebt < oldAboveDebt) {
    // scrolledOffAbove pushes newest at the end (closest to on-screen).
    const drop = oldAboveDebt - newAboveDebt
    s.scrolledOffAbove.length -= drop
    s.scrolledOffAboveSW.length = s.scrolledOffAbove.length
  }
  if (newBelowDebt < oldBelowDebt) {
    // scrolledOffBelow unshifts newest at the front (closest to on-screen).
    const drop = oldBelowDebt - newBelowDebt
    s.scrolledOffBelow.splice(0, drop)
    s.scrolledOffBelowSW.splice(0, drop)
  }
  // Invariant: accumulator length ≤ debt. If the accumulator exceeds debt,
  // the excess is stale — e.g., moveFocus cleared virtualFocusRow without
  // trimming the accumulator, orphaning entries the pop above can never
  // reach because oldDebt was ALREADY 0. Truncate to debt (keeping the
  // newest = closest-to-on-screen entries). Check newDebt (not oldDebt):
  // captureScrolledRows runs BEFORE this shift in the real flow (ink.tsx),
  // so at entry the accumulator is populated but oldDebt is still 0 —
  // that's the normal establish-debt path, not stale.
  if (s.scrolledOffAbove.length > newAboveDebt) {
    // Above pushes newest at END → keep END.
    s.scrolledOffAbove = newAboveDebt > 0 ? s.scrolledOffAbove.slice(-newAboveDebt) : []
    s.scrolledOffAboveSW = newAboveDebt > 0 ? s.scrolledOffAboveSW.slice(-newAboveDebt) : []
  }
  if (s.scrolledOffBelow.length > newBelowDebt) {
    // Below unshifts newest at FRONT → keep FRONT.
    s.scrolledOffBelow = s.scrolledOffBelow.slice(0, newBelowDebt)
    s.scrolledOffBelowSW = s.scrolledOffBelowSW.slice(0, newBelowDebt)
  }
  // Clamp col depends on which EDGE (not dRow direction): virtual tracking
  // means a top-clamped point can stay top-clamped during a dRow>0 reverse
  // shift — dRow-based clampCol would give it the bottom col.
  const shift = (p: Point, vRow: number): Point => {
    if (vRow < minRow) return { col: 0, row: minRow }
    if (vRow > maxRow) return { col: width - 1, row: maxRow }
    return { col: p.col, row: vRow }
  }
  s.anchor = shift(s.anchor, vAnchor)
  s.focus = shift(s.focus, vFocus)
  s.virtualAnchorRow = vAnchor < minRow || vAnchor > maxRow ? vAnchor : undefined
  s.virtualFocusRow = vFocus < minRow || vFocus > maxRow ? vFocus : undefined
  // anchorSpan 不进行虚拟跟踪：它用于字/行拖拽扩展，
  // 与键盘滚动往返情况无关。
  if (s.anchorSpan) {
    const sp = (p: Point): Point => {
      const r = p.row + dRow
      if (r < minRow) return { col: 0, row: minRow }
      if (r > maxRow) return { col: width - 1, row: maxRow }
      return { col: p.col, row: r }
    }
    s.anchorSpan = {
      lo: sp(s.anchorSpan.lo),
      hi: sp(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
}

/**
 * 移动 anchor 行 dRow，钳位到 [minRow, maxRow]。
 * 用于拖拽滚动：当 ScrollBox 滚动 N 行时，
 * anchor 下的内容现在位于不同的视口行，所以 anchor
 * 必须跟随它。Focus 保持不变（保持在鼠标位置）。
 */
export function shiftAnchor(s: SelectionState, dRow: number, minRow: number, maxRow: number): void {
  if (!s.anchor) return
  // 与 shiftSelection/shiftSelectionForFollow 相同的虚拟行跟踪：
  // 拖拽→跟随转换交给 shiftSelectionForFollow，它读取
  // (virtualAnchorRow ?? anchor.row)。没有这个，拖拽阶段钳位
  // 留下 virtual 为 undefined → follow 从已钳位的行初始化，
  // 低估总漂移 → shiftSelection 的不变量恢复
  // 过早清除有效的拖拽阶段累加器条目。
  const raw = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  s.anchor = { col: s.anchor.col, row: clamp(raw, minRow, maxRow) }
  s.virtualAnchorRow = raw < minRow || raw > maxRow ? raw : undefined
  // anchorSpan 不进行虚拟跟踪（字/行扩展，与
  // 键盘滚动往返无关）— 从当前行直接钳位。
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, minRow, maxRow),
    })
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
}

/**
 * 移动整个选择（anchor + focus + anchorSpan）dRow，钳位到 [minRow, maxRow]。
 * 用于选择活动时的 sticky/auto-follow 滚动 ScrollBox —
 * 原生终端行为是高亮跟随文本向上移动屏幕
 *（而不是保持在相同屏幕位置）。
 *
 * 与 shiftAnchor 不同：在拖拽滚动期间，focus 跟踪实时
 * 鼠标位置，只有 anchor 跟随文本。在流式跟随期间，
 * 选择在两端都是文本锚定的 — 两者都必须移动。
 * ink.tsx 中的 isDragging 检查决定应用哪种移动。
 *
 * 如果两端都会严格移动到 minRow 下方（未钳位），
 * 选择的文本已完全滚动出顶部。清除它 —
 * 否则单个倒转单元格会在视口顶部作为幽灵残留
 *（当选择离开 scrollback 时，原生终端会放下选择）。
 * 落在 minRow 仍然有效：该单元格保存正确的文本。
 * 如果选择被清除则返回 true，以便调用者可以通知 React 层订阅者
 *（useHasSelection）— 调用者在 onRender 内部，所以不能使用
 * notifySelectionChange（递归），必须直接触发监听器。
 */
export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): boolean {
  if (!s.anchor) return false
  // 镜像 shiftSelection：从虚拟位置计算原始（未钳位）位置
  //（如果已设置），否则从当前位置计算。这处理更新路径
  //（虚拟已从之前的键盘滚动设置）和初始化路径
  //（第一次钳位通过 follow-scroll 在这里发生，无之前的键盘滚动）。
  // 没有初始化路径，follow-scroll-first 留下 virtual 为 undefined，
  // 即使下面的钳位已发生 → 后来的 PgUp 从钳位的行
  // 而不是真正的预钳位行计算债务，并且永远不会弹出累加器
  // — getSelectedText 重复计算屏幕外的行。
  const rawAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const rawFocus = s.focus ? (s.virtualFocusRow ?? s.focus.row) + dRow : undefined
  if (rawAnchor < minRow && rawFocus !== undefined && rawFocus < minRow) {
    clearSelection(s)
    return true
  }
  // 从原始位置钳位，而不是 p.row+dRow — 这样回到边界内的
  // 虚拟位置落在真实位置，而不是陈旧的钳位位置。
  s.anchor = { col: s.anchor.col, row: clamp(rawAnchor, minRow, maxRow) }
  if (s.focus && rawFocus !== undefined) {
    s.focus = { col: s.focus.col, row: clamp(rawFocus, minRow, maxRow) }
  }
  s.virtualAnchorRow = rawAnchor < minRow || rawAnchor > maxRow ? rawAnchor : undefined
  s.virtualFocusRow =
    rawFocus !== undefined && (rawFocus < minRow || rawFocus > maxRow) ? rawFocus : undefined
  // anchorSpan 不进行虚拟跟踪（字/行扩展，与
  // 键盘滚动往返无关）— 从当前行直接钳位。
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, minRow, maxRow),
    })
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    }
  }
  return false
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

/**
 * 归一化选择边界：start 在阅读顺序中始终在 end 之前。
 * 如果没有活动选择则返回 null。
 */
export function selectionBounds(s: SelectionState): {
  start: { col: number; row: number }
  end: { col: number; row: number }
} | null {
  if (!s.anchor || !s.focus) return null
  return comparePoints(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor }
}

/**
 * 检查（col, row）处的单元格是否在当前选择范围内。
 * 由渲染器用于应用反向样式。
 */
export function isCellSelected(s: SelectionState, col: number, row: number): boolean {
  const b = selectionBounds(s)
  if (!b) return false
  const { start, end } = b
  if (row < start.row || row > end.row) return false
  if (row === start.row && col < start.col) return false
  if (row === end.row && col > end.col) return false
  return true
}

/** 从一个屏幕行提取文本。当下一行是软换行
 *  延续（screen.softWrap[row+1]>0）时，钳位到该内容末尾
 *  列并跳过尾部修剪，以便词分隔符空格在连接时保留。
 *  见 Screen.softWrap 了解为什么钳位是必要的。 */
function extractRowText(screen: Screen, row: number, colStart: number, colEnd: number): string {
  const noSelect = screen.noSelect
  const rowOff = row * screen.width
  const contentEnd = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
  const lastCol = contentEnd > 0 ? Math.min(colEnd, contentEnd - 1) : colEnd
  let line = ''
  for (let col = colStart; col <= lastCol; col++) {
    // 跳过标记为 noSelect 的单元格（装订线、行号、差异符号）。
    // 在 cellAt 之前检查以避免对被排除单元格的解码开销。
    if (noSelect[rowOff + col] === 1) continue
    const cell = cellAt(screen, col, row)
    if (!cell) continue
    // 跳过 spacer tail（宽字符的后半部分）— head 已包含
    // 完整的字素。SpacerHead 是行尾的空白。
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) {
      continue
    }
    line += cell.char
  }
  return contentEnd > 0 ? line : line.replace(/\s+$/, '')
}

/** 累加器用于选择文本，将软换行行合并回
 *  逻辑行。push(text, sw) 仅在 sw=false 时在文本前追加换行符
 *（即该行开始新的逻辑行）。sw=true 的行
 *  连接到前一行。 */
function joinRows(lines: string[], text: string, sw: boolean | undefined): void {
  if (sw && lines.length > 0) {
    lines[lines.length - 1] += text
  } else {
    lines.push(text)
  }
}

/**
 * 从屏幕缓冲区中提取选择范围内的文本。
 * 行用换行符连接，除非屏幕的 softWrap 位图
 * 将行标记为单词换行延续 — 这些行连接到
 * 前一行，以便复制的文本匹配逻辑源行，
 * 而不是视觉换行布局。每个逻辑行最后
 * 片段的尾部空白被修剪。跳过宽字符 spacer 单元格。
 * 在拖拽滚动期间滚动出视口的行
 * 从 scrolledOffAbove/Below 累加器及其捕获的 softWrap 位
 * 重新加入。
 */
export function getSelectedText(s: SelectionState, screen: Screen): string {
  const b = selectionBounds(s)
  if (!b) return ''
  const { start, end } = b
  const sw = screen.softWrap
  const lines: string[] = []

  for (let i = 0; i < s.scrolledOffAbove.length; i++) {
    joinRows(lines, s.scrolledOffAbove[i]!, s.scrolledOffAboveSW[i])
  }

  for (let row = start.row; row <= end.row; row++) {
    const rowStart = row === start.row ? start.col : 0
    const rowEnd = row === end.row ? end.col : screen.width - 1
    joinRows(lines, extractRowText(screen, row, rowStart, rowEnd), sw[row]! > 0)
  }

  for (let i = 0; i < s.scrolledOffBelow.length; i++) {
    joinRows(lines, s.scrolledOffBelow[i]!, s.scrolledOffBelowSW[i])
  }

  return lines.join('\n')
}

/**
 * 在拖拽滚动期间从即将滚动出视口的行捕获文本，
 * 在 scrollBy 覆盖它们之前。只捕获与选择相交的行，
 * 使用选择的列边界作为 anchor 侧边界行。
 * 捕获 anchor 行后，anchor.col 和 anchorSpan col 都重置为全宽边界，
 * 以便后续捕获和最终的 getSelectedText 不会对不再在原始 anchor 下的
 * 内容重新应用陈旧的列约束。
 * 两个 span col 都重置（不仅是近端）：在被阻止的反转后，
 * 拖拽可以翻转方向，然后 extendSelection 读取相反的 span 侧
 * — 否则仍将保留原始字边界并截断一个后续捕获的行。
 *
 * side='above'：从顶部滚动出的行（向下拖拽，anchor=start）。
 * side='below'：从底部滚动出的行（向上拖拽，anchor=end）。
 */
export function captureScrolledRows(
  s: SelectionState,
  screen: Screen,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
): void {
  const b = selectionBounds(s)
  if (!b || firstRow > lastRow) return
  const { start, end } = b
  // 将 [firstRow, lastRow] 与 [start.row, end.row] 相交。
  // 选择外的行不被捕获 — 它们未被选中。
  const lo = Math.max(firstRow, start.row)
  const hi = Math.min(lastRow, end.row)
  if (lo > hi) return

  const width = screen.width
  const sw = screen.softWrap
  const captured: string[] = []
  const capturedSW: boolean[] = []
  for (let row = lo; row <= hi; row++) {
    const colStart = row === start.row ? start.col : 0
    const colEnd = row === end.row ? end.col : width - 1
    captured.push(extractRowText(screen, row, colStart, colEnd))
    capturedSW.push(sw[row]! > 0)
  }

  if (side === 'above') {
    // 最新的行在 above-累加器的底部（最接近
    // 阅读顺序中的屏幕内容）。
    s.scrolledOffAbove.push(...captured)
    s.scrolledOffAboveSW.push(...capturedSW)
    // 我们刚刚捕获了选择的顶部。anchor（向下拖拽时=start）
    // 现在指向将滚动出的内容；其列约束已应用于
    // 捕获的行。重置为 col 0，以便下一次 tick 和最终的
    // getSelectedText 读取整行。
    if (s.anchor && s.anchor.row === start.row && lo === start.row) {
      s.anchor = { col: 0, row: s.anchor.row }
      if (s.anchorSpan) {
        s.anchorSpan = {
          kind: s.anchorSpan.kind,
          lo: { col: 0, row: s.anchorSpan.lo.row },
          hi: { col: width - 1, row: s.anchorSpan.hi.row },
        }
      }
    }
  } else {
    // 最新的行在 below-累加器的顶部 — 它们
    // 最接近屏幕内容。
    s.scrolledOffBelow.unshift(...captured)
    s.scrolledOffBelowSW.unshift(...capturedSW)
    if (s.anchor && s.anchor.row === end.row && hi === end.row) {
      s.anchor = { col: width - 1, row: s.anchor.row }
      if (s.anchorSpan) {
        s.anchorSpan = {
          kind: s.anchorSpan.kind,
          lo: { col: 0, row: s.anchorSpan.lo.row },
          hi: { col: width - 1, row: s.anchorSpan.hi.row },
        }
      }
    }
  }
}

/**
 * 将选择覆盖直接应用到屏幕缓冲区，通过更改
 * 选择范围内每个单元格的样式。在渲染器生成
 * Frame 之后但在 diff 之前调用 — 正常的 diffEach
 * 然后将其余样单元格作为普通更改拾取，所以 LogUpdate
 * 保持为纯 diff 引擎，无选择感知。
 *
 * 使用实心选择背景（通过 StylePool.setSelectionBg 提供主题），
 * 替换每个单元格的背景但保留其前景 —
 * 匹配原生终端选择。之前使用 SGR-7 反向（交换
 * 每个单元格的前景色/背景色），在语法高亮文本上碎片化严重：
 * 每个不同的前景色变成不同的背景条纹。
 *
 * 使用 StylePool 缓存，所以拖拽时每个单元格的工作只是 Map
 * 查找 + packed-int 写入。
 */
export function applySelectionOverlay(
  screen: Screen,
  selection: SelectionState,
  stylePool: StylePool,
): void {
  const b = selectionBounds(selection)
  if (!b) return
  const { start, end } = b
  const width = screen.width
  const noSelect = screen.noSelect
  for (let row = start.row; row <= end.row && row < screen.height; row++) {
    const colStart = row === start.row ? start.col : 0
    const colEnd = row === end.row ? Math.min(end.col, width - 1) : width - 1
    const rowOff = row * width
    for (let col = colStart; col <= colEnd; col++) {
      const idx = rowOff + col
      // 跳过 noSelect 单元格 — 装订线保持视觉不变，所以很清楚
      // 它们不属于复制的一部分。周围的可选择单元格
      // 仍然高亮，所以选择范围保持可见。
      if (noSelect[idx] === 1) continue
      const cell = cellAtIndex(screen, idx)
      setCellStyleId(screen, col, row, stylePool.withSelectionBg(cell.styleId))
    }
  }
}
