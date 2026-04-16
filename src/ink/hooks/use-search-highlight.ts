import { useContext, useMemo } from 'react'
import StdinContext from '../components/StdinContext.js'
import type { DOMElement } from '../dom.js'
import instances from '../instances.js'
import type { MatchPosition } from '../render-to-screen.js'

/**
 * 在 Ink 实例上设置搜索高亮查询。非空值 → 下一帧所有
 * 可见匹配项都会反色显示（SGR 7，屏幕缓冲区叠加层，与选择
 * 使用相同的损伤机制）。空值 → 清除。
 *
 * 这是屏幕空间高亮——匹配的是渲染后的文本，而非源消息文本。
 * 对任何可见内容都有效（bash 输出、文件路径、错误消息），
 * 无论它在消息树中的来源。在源中匹配但被截断/省略的内容
 * 不会高亮；这是可接受的——我们高亮的是你看到的内容。
 */
export function useSearchHighlight(): {
  setQuery: (query: string) => void
  /** 将现有 DOM 子树（来自主树）绘制到新的 Screen 上，
   *  以其自然高度扫描。元素相对位置（第 0 行 = 元素顶部）。
   *  零上下文重复——元素就是用所有真实 provider 构建的那个。 */
  scanElement: (el: DOMElement) => MatchPosition[]
  /** 基于位置的当前高亮。每帧在 positions[currentIdx] + rowOffset
   *  处绘制黄色。扫描高亮（所有匹配项反色）仍然运行——这个叠加
   *  在其之上。rowOffset 跟踪滚动；位置保持稳定（相对于消息）。
   *  null 清除。 */
  setPositions: (
    state: {
      positions: MatchPosition[]
      rowOffset: number
      currentIdx: number
    } | null,
  ) => void
} {
  useContext(StdinContext) // anchor to App subtree for hook rules
  const ink = instances.get(process.stdout)
  return useMemo(() => {
    if (!ink) {
      return {
        setQuery: () => {},
        scanElement: () => [],
        setPositions: () => {},
      }
    }
    return {
      setQuery: (query: string) => ink.setSearchHighlight(query),
      scanElement: (el: DOMElement) => ink.scanElementSubtree(el),
      setPositions: state => ink.setSearchPositions(state),
    }
  }, [ink])
}
