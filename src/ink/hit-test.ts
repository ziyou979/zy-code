import type { DOMElement } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import type { EventHandlerProps } from './events/event-handlers.js'
import { nodeCache } from './node-cache.js'

/**
 * 查找渲染矩形包含 (col, row) 的最深 DOM 元素。
 *
 * 使用 renderNodeToOutput 填充的 nodeCache——矩形使用屏幕坐标，
 * 所有偏移（包括 scrollTop 平移）已应用。子节点逆序遍历，以便
 * 后渲染的兄弟节点（绘制在上层）优先命中。不在 nodeCache 中的
 * 节点（本帧未渲染或缺少 yogaNode）及其子树会被跳过。
 *
 * 即使命中节点没有 onClick 也会返回——dispatchClick 会通过
 * parentNode 向上查找处理器。
 */
export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  const rect = nodeCache.get(node)
  if (!rect) return null
  if (
    col < rect.x ||
    col >= rect.x + rect.width ||
    row < rect.y ||
    row >= rect.y + rect.height
  ) {
    return null
  }
  // 后渲染的兄弟节点绘制在上层；逆序遍历返回最上层的命中结果。
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row)
    if (hit) return hit
  }
  return node
}

/**
 * 在 (col, row) 处对 root 进行命中测试，并从最深的包含节点
 * 向上通过 parentNode 冒泡 ClickEvent。只有带 onClick 处理器的
 * 节点才会触发。当处理器调用 stopImmediatePropagation() 时停止。
 * 至少有一个 onClick 处理器触发时返回 true。
 */
export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
): boolean {
  let target: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  if (!target) return false

  // 点击聚焦：查找最近的聚焦祖先并聚焦它。
  // root 始终是 ink-root，它拥有 FocusManager。
  if (root.focusManager) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }
  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  while (target) {
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      handled = true
      const rect = nodeCache.get(target)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      }
      handler(event)
      if (event.didStopImmediatePropagation()) return true
    }
    target = target.parentNode
  }
  return handled
}

/**
 * 当指针移动时触发 onMouseEnter/onMouseLeave。类似 DOM
 * mouseenter/mouseleave：不冒泡——在子节点之间移动不会重新在父节点上触发。
 * 从命中节点向上遍历，收集所有带 hover 处理器的祖先节点；与之前的
 * hover 集合做差集；对退出的节点触发 leave，对进入的节点触发 enter。
 *
 * 原地修改 `hovered`，以便调用者（App 实例）在多次调用之间持有它。
 * 当命中为 null 时清空集合（光标移入未渲染的间隙或离开 root 矩形）。
 */
export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
): void {
  const next = new Set<DOMElement>()
  let node: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  while (node) {
    const h = node._eventHandlers as EventHandlerProps | undefined
    if (h?.onMouseEnter || h?.onMouseLeave) next.add(node)
    node = node.parentNode
  }
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // 跳过已分离节点上的处理器（在两次鼠标事件之间被移除）
      if (old.parentNode) {
        ;(old._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
      }
    }
  }
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      ;(n._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
    }
  }
}
