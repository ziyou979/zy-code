import type { DOMElement } from './dom.js'
import { FocusEvent } from './events/focus-event.js'

const MAX_FOCUS_STACK = 32

/**
 * 用于 Ink 终端 UI 的类 DOM 焦点管理器。
 *
 * 纯状态 — 跟踪 activeElement 和焦点栈。没有对树的引用；
 * 调用者在需要树遍历时传递根节点。
 *
 * 存储在根 DOMElement 上，这样任何节点都可以通过 walking
 * parentNode 访问它（类似浏览器的 `node.ownerDocument`）。
 */
export class FocusManager {
  activeElement: DOMElement | null = null
  private dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean
  private enabled = true
  private focusStack: DOMElement[] = []

  constructor(dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean) {
    this.dispatchFocusEvent = dispatchFocusEvent
  }

  focus(node: DOMElement): void {
    if (node === this.activeElement) {
      return
    }
    if (!this.enabled) {
      return
    }

    const previous = this.activeElement
    if (previous) {
      // 去重后再推入，防止 Tab 循环导致无限增长
      const idx = this.focusStack.indexOf(previous)
      if (idx !== -1) {
        this.focusStack.splice(idx, 1)
      }
      this.focusStack.push(previous)
      if (this.focusStack.length > MAX_FOCUS_STACK) {
        this.focusStack.shift()
      }
      this.dispatchFocusEvent(previous, new FocusEvent('blur', node))
    }
    this.activeElement = node
    this.dispatchFocusEvent(node, new FocusEvent('focus', previous))
  }

  blur(): void {
    if (!this.activeElement) {
      return
    }

    const previous = this.activeElement
    this.activeElement = null
    this.dispatchFocusEvent(previous, new FocusEvent('blur', null))
  }

  /**
   * 当节点从树中移除时由协调器调用。
   * 处理精确节点和被移除子树中任何有焦点的后代。
   * 分发 blur 并从栈中恢复焦点。
   */
  handleNodeRemoved(node: DOMElement, root: DOMElement): void {
    // 从栈中移除该节点及其任何后代
    this.focusStack = this.focusStack.filter((n) => n !== node && isInTree(n, root))

    // 检查 activeElement 是否是被移除的节点或是其后代
    if (!this.activeElement) {
      return
    }
    if (this.activeElement !== node && isInTree(this.activeElement, root)) {
      return
    }

    const removed = this.activeElement
    this.activeElement = null
    this.dispatchFocusEvent(removed, new FocusEvent('blur', null))

    // 将焦点恢复到最近仍挂载的元素
    while (this.focusStack.length > 0) {
      const candidate = this.focusStack.pop()!
      if (isInTree(candidate, root)) {
        this.activeElement = candidate
        this.dispatchFocusEvent(candidate, new FocusEvent('focus', removed))
        return
      }
    }
  }

  handleAutoFocus(node: DOMElement): void {
    this.focus(node)
  }

  handleClickFocus(node: DOMElement): void {
    const tabIndex = node.attributes.tabIndex
    if (typeof tabIndex !== 'number') {
      return
    }
    this.focus(node)
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  focusNext(root: DOMElement): void {
    this.moveFocus(1, root)
  }

  focusPrevious(root: DOMElement): void {
    this.moveFocus(-1, root)
  }

  private moveFocus(direction: 1 | -1, root: DOMElement): void {
    if (!this.enabled) {
      return
    }

    const tabbable = collectTabbable(root)
    if (tabbable.length === 0) {
      return
    }

    const currentIndex = this.activeElement ? tabbable.indexOf(this.activeElement) : -1

    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : tabbable.length - 1
        : (currentIndex + direction + tabbable.length) % tabbable.length

    const next = tabbable[nextIndex]
    if (next) {
      this.focus(next)
    }
  }
}

function collectTabbable(root: DOMElement): DOMElement[] {
  const result: DOMElement[] = []
  walkTree(root, result)
  return result
}

function walkTree(node: DOMElement, result: DOMElement[]): void {
  const tabIndex = node.attributes.tabIndex
  if (typeof tabIndex === 'number' && tabIndex >= 0) {
    result.push(node)
  }

  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      walkTree(child, result)
    }
  }
}

function isInTree(node: DOMElement, root: DOMElement): boolean {
  let current: DOMElement | undefined = node
  while (current) {
    if (current === root) {
      return true
    }
    current = current.parentNode
  }
  return false
}

/**
 * 向上遍历到根节点并返回它。根节点是持有
 * FocusManager 的节点 — 类似浏览器的 `node.getRootNode()`。
 */
export function getRootNode(node: DOMElement): DOMElement {
  let current: DOMElement | undefined = node
  while (current) {
    if (current.focusManager) {
      return current
    }
    current = current.parentNode
  }
  throw new Error('Node is not in a tree with a FocusManager')
}

/**
 * 向上遍历到根节点并返回其 FocusManager。
 * 类似浏览器的 `node.ownerDocument` — 焦点属于根节点。
 */
export function getFocusManager(node: DOMElement): FocusManager {
  return getRootNode(node).focusManager!
}
