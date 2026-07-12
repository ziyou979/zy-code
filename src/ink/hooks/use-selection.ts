import { useContext, useMemo, useSyncExternalStore } from 'react'
import StdinContext from '../components/StdinContext.js'
import instances from '../instances.js'
import { type FocusMove, type SelectionState, shiftAnchor } from '../selection.js'

/**
 * 访问 Ink 实例上的文本选择操作（仅全屏模式）。
 * 禁用全屏模式时返回 no-op 函数。
 */
export function useSelection(): {
  copySelection: () => string
  /** 复制但不清除高亮（用于选中即复制）。 */
  copySelectionNoClear: () => string
  /** 仅读取选区文本，不写剪贴板、不清选区。 */
  getSelectedText: () => string
  clearSelection: () => void
  hasSelection: () => boolean
  /** 读取原始可变选择状态（用于拖拽滚动）。 */
  getState: () => SelectionState | null
  /** 订阅选择变更（start/update/finish/clear）。 */
  subscribe: (cb: () => void) => () => void
  /** 将 anchor 行移动 dRow，限制在 [minRow, maxRow] 范围内。 */
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  /** 同时移动 anchor 和 focus dRow（键盘滚动：整个选择区域
   *  跟踪内容）。被限制的点的 col 会被重置为全宽边缘，
   *  因为其内容已被 captureScrolledRows 捕获。从 ink 实例
   *  读取 screen.width 作为 col 重置边界。 */
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
  /** 键盘选择扩展（shift+arrow）：移动 focus，anchor 固定。
   *  左右跨行包裹；上下在视口边缘处限制。 */
  moveFocus: (move: FocusMove) => void
  /** 捕获即将滚出视口的行的文本（在 scrollBy 之前调用，
   *  这样屏幕缓冲区仍有即将离开的行）。 */
  captureScrolledRows: (firstRow: number, lastRow: number, side: 'above' | 'below') => void
  /** 设置选择高亮背景色（主题接入；实色背景
   *  替代旧的 SGR-7 反色，使语法高亮在选择下仍可读）。
   *  挂载时调用一次 + 主题变化时调用。 */
  setSelectionBgColor: (color: string) => void
} {
  // 通过 stdout 查找 Ink 实例——与 instances map 相同的模式。
  // StdinContext 始终可用，Ink 实例通过 stdout 键查找，
  // 实践中每个进程只有一个 Ink 实例。
  useContext(StdinContext) // anchor to App subtree for hook rules
  const ink = instances.get(process.stdout)
  // 使用 useMemo 缓存，调用者可安全地将返回值放入依赖数组。
  // ink 是每个 stdout 的单例——在渲染间保持稳定。
  return useMemo(() => {
    if (!ink) {
      return {
        copySelection: () => '',
        copySelectionNoClear: () => '',
        getSelectedText: () => '',
        clearSelection: () => {},
        hasSelection: () => false,
        getState: () => null,
        subscribe: () => () => {},
        shiftAnchor: () => {},
        shiftSelection: () => {},
        moveFocus: () => {},
        captureScrolledRows: () => {},
        setSelectionBgColor: () => {},
      }
    }
    return {
      copySelection: () => ink.copySelection(),
      copySelectionNoClear: () => ink.copySelectionNoClear(),
      getSelectedText: () => ink.getSelectedText(),
      clearSelection: () => ink.clearTextSelection(),
      hasSelection: () => ink.hasTextSelection(),
      getState: () => ink.selection,
      subscribe: (cb: () => void) => ink.subscribeToSelectionChange(cb),
      shiftAnchor: (dRow: number, minRow: number, maxRow: number) =>
        shiftAnchor(ink.selection, dRow, minRow, maxRow),
      shiftSelection: (dRow, minRow, maxRow) => ink.shiftSelectionForScroll(dRow, minRow, maxRow),
      moveFocus: (move: FocusMove) => ink.moveSelectionFocus(move),
      captureScrolledRows: (firstRow, lastRow, side) =>
        ink.captureScrolledRows(firstRow, lastRow, side),
      setSelectionBgColor: (color: string) => ink.setSelectionBgColor(color),
    }
  }, [ink])
}

const NO_SUBSCRIBE = () => () => {}
const ALWAYS_FALSE = () => false

/**
 * 响应式选择存在状态。创建或清除文本选择时会重新渲染调用者。
 * 全屏模式外始终返回 false（选择仅在 alt-screen 中可用）。
 */
export function useHasSelection(): boolean {
  useContext(StdinContext)
  const ink = instances.get(process.stdout)
  return useSyncExternalStore(
    ink ? ink.subscribeToSelectionChange : NO_SUBSCRIBE,
    ink ? ink.hasTextSelection : ALWAYS_FALSE,
  )
}
