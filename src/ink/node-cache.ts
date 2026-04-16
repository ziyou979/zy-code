import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'

/**
 * 每个渲染节点的缓存布局边界（用于 blit 和清除）。
 * `top` 是 yoga 本地的 getComputedTop() —— 存储它以便 ScrollBox 视口
 * 裁剪能够跳过 yoga 读取，用于位置未改变的干净子节点
 *（首遍从 O(mounted) 降至 O(dirty)）。
 */
export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
}

export const nodeCache = new WeakMap<DOMElement, CachedLayout>()

/** 下次渲染时需要清除的已移除子节点的矩形区域 */
export const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

/**
 * 当为绝对定位的节点添加 pendingClear 时设置。
 * 通知渲染器在下一帧禁用 blit：被移除的节点
 * 可能绘制在非兄弟元素上方（例如树顺序中较早的 ScrollBox
 * 上的覆盖层），因此来自 prevScreen 的 blit 会恢复
 * 覆盖层的像素。普通流的移除已通过父级 hasRemovedChild 处理；
 * 只有绝对定位会跨子树绘制。每轮渲染开始时重置。
 */
let absoluteNodeRemoved = false

export function addPendingClear(
  parent: DOMElement,
  rect: Rectangle,
  isAbsolute: boolean,
): void {
  const existing = pendingClears.get(parent)
  if (existing) {
    existing.push(rect)
  } else {
    pendingClears.set(parent, [rect])
  }
  if (isAbsolute) {
    absoluteNodeRemoved = true
  }
}

export function consumeAbsoluteRemovedFlag(): boolean {
  const had = absoluteNodeRemoved
  absoluteNodeRemoved = false
  return had
}
