import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'
import type { DOMElement } from '../dom.js'

type ViewportEntry = {
  /**
   * 元素当前是否在终端视口内
   */
  isVisible: boolean
}

/**
 * Hook 用于检测组件是否在终端视口内。
 *
 * 返回一个回调 ref 和一个视口条目对象。
 * 将 ref 附加到要跟踪的组件上即可。
 *
 * 条目在 layout 阶段更新（useLayoutEffect），因此调用者在渲染期间
 * 总能读取到最新值。可见性变化本身不会触发重新渲染——因其他原因
 * （如动画滴答、状态变化）重新渲染的调用者会自然获取最新值。
 * 这避免了与也调用 setState 的其他 layout effects 结合时
 * 产生无限更新循环。
 *
 * @example
 * const [ref, entry] = useTerminalViewport()
 * return <Box ref={ref}><Animation enabled={entry.isVisible}>...</Animation></Box>
 */
export function useTerminalViewport(): [
  ref: (element: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  const terminalSize = useContext(TerminalSizeContext)
  const elementRef = useRef<DOMElement | null>(null)
  const entryRef = useRef<ViewportEntry>({ isVisible: true })

  const setElement = useCallback((el: DOMElement | null) => {
    elementRef.current = el
  }, [])

  // 每次渲染都运行，因为 yoga 布局值可能在 React 不知情的情况下变化。
  // 只更新 ref——不使用 setState，避免在 commit 阶段级联重新渲染。
  // 每次都重新遍历 DOM 祖先链，避免在 yoga 树重建后持有过期引用。
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element?.yogaNode || !terminalSize) {
      return
    }

    const height = element.yogaNode.getComputedHeight()
    const rows = terminalSize.rows

    // 遍历 DOM 父链（而非 yoga.getParent()），这样可以检测滚动容器
    // 并减去它们的 scrollTop。yoga 计算布局位置时不考虑滚动偏移——
    // scrollTop 在渲染时应用。没有这个处理，ScrollBox 内 yoga 位置
    // 超过 terminalRows 的元素会被认为在屏幕外，即使已滚动到可视区域
    // （例如全屏模式下积累足够多消息后的 spinner）。
    let absoluteTop = element.yogaNode.getComputedTop()
    let parent: DOMElement | undefined = element.parentNode
    let root = element.yogaNode
    while (parent) {
      if (parent.yogaNode) {
        absoluteTop += parent.yogaNode.getComputedTop()
        root = parent.yogaNode
      }
      // scrollTop 仅在滚动容器上设置（由 ScrollBox + renderer 设置）。
      // 非滚动节点的 scrollTop 为 undefined → 快速路径跳过。
      if (parent.scrollTop) absoluteTop -= parent.scrollTop
      parent = parent.parentNode
    }

    // 只有根节点的高度有意义
    const screenHeight = root.getComputedHeight()

    const bottom = absoluteTop + height
    // 当内容超出视口时（screenHeight > rows），帧末的光标恢复会
    // 多滚动一行到回滚区。log-update.ts 通过 scrollbackRows = viewportY + 1
    // 来处理这一点。我们必须匹配，否则边界处的元素在这里被认为是"可见"的
    // （动画继续滴答），但其行被 log-update 当作回滚区处理
    // （内容变化 → 完全重置 → 闪烁）。
    const cursorRestoreScroll = screenHeight > rows ? 1 : 0
    const viewportY = Math.max(0, screenHeight - rows) + cursorRestoreScroll
    const viewportBottom = viewportY + rows
    const visible = bottom > viewportY && absoluteTop < viewportBottom

    if (visible !== entryRef.current.isVisible) {
      entryRef.current = { isVisible: visible }
    }
  })

  return [setElement, entryRef.current]
}
