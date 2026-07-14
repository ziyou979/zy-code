/**
 * 将虚拟列表 / sticky 头部的 DOM 节点映射到元数据，供 hit-test 使用。
 * - 消息行：拖选删除时 preferredUuid 定位
 * - 顶部 sticky 用户消息：双击滚回该条对话起始位置
 */

import type { DOMElement } from './dom.js'

export type MessageHitMeta = {
  uuid: string
  /** RenderableMessage.type（user / assistant / system 等） */
  type: string
}

const metaByElement = new WeakMap<DOMElement, MessageHitMeta>()

/** 在 VirtualItem 的 measure ref 上注册；el 为 null 时忽略（WeakMap 随节点 GC）。 */
export function registerMessageHitTarget(el: DOMElement | null, meta: MessageHitMeta | null): void {
  if (el && meta) {
    metaByElement.set(el, meta)
  }
}

/** 从命中节点向上查找最近的消息行元数据。 */
export function findMessageHitMeta(node: DOMElement | null | undefined): MessageHitMeta | null {
  let cur: DOMElement | null | undefined = node
  while (cur) {
    const meta = metaByElement.get(cur)
    if (meta) {
      return meta
    }
    cur = cur.parentNode
  }
  return null
}

/** 顶部钉住的用户消息条：双击时调用 scrollTo 回到该条起始位置。 */
export type StickyHeaderHitMeta = {
  scrollTo: () => void
}

const stickyHeaderByElement = new WeakMap<DOMElement, StickyHeaderHitMeta>()

/** StickyPromptHeader 的 ref 注册。 */
export function registerStickyHeaderHitTarget(
  el: DOMElement | null,
  scrollTo: (() => void) | null | undefined,
): void {
  if (el && scrollTo) {
    stickyHeaderByElement.set(el, { scrollTo })
  }
}

/** 从命中节点向上查找 sticky 头部（仅顶部钉住条，不是 scrollback 内消息）。 */
export function findStickyHeaderHitMeta(
  node: DOMElement | null | undefined,
): StickyHeaderHitMeta | null {
  let cur: DOMElement | null | undefined = node
  while (cur) {
    const meta = stickyHeaderByElement.get(cur)
    if (meta) {
      return meta
    }
    cur = cur.parentNode
  }
  return null
}
