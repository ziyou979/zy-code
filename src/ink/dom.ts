import type { FocusManager } from './focus.js'
import { createLayoutNode } from './layout/engine.js'
import type { LayoutNode } from './layout/node.js'
import { LayoutDisplay, LayoutMeasureMode } from './layout/node.js'
import measureText from './measureText.js'
import { addPendingClear, nodeCache } from './nodeCache.js'
import squashTextNodes from './squashTextNodes.js'
import type { Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrapText.js'

type InkNode = {
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode
  style: Styles
}

export type TextName = '#text'
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'

export type NodeNames = ElementNames | TextName

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMElement = {
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles

  // 内部属性
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
  // 用于在 React 19 测试模式的效果双重调用期间跳过空渲染
  hasRenderedContent?: boolean

  // 当为 true 时，此节点需要重新渲染
  dirty: boolean
  // 由协调器的 hideInstance/unhideInstance 设置；在样式更新后仍然存在。
  isHidden?: boolean
  // 由协调器设置的事件处理程序，用于 capture/bubble 分发器。
  // 单独存储而不是放在 attributes 中，这样处理函数标识变化不会
  // 标记为 dirty 并破坏 blit 优化。
  _eventHandlers?: Record<string, unknown>

  // overflow: 'scroll' 盒子的滚动状态。scrollTop 是内容向下滚动的行数。
  // scrollHeight/scrollViewportHeight 在渲染时计算并存储，用于命令式访问。
  // stickyScroll 在内容增长时自动将 scrollTop 固定到底部。
  scrollTop?: number
  // 累积的滚动增量，尚未应用到 scrollTop。渲染器
  // 以 SCROLL_MAX_PER_FRAME 行/帧的速度释放此值，因此快速滚动会显示
  // 中间帧而不是一个大跳跃。方向反转
  // 会自然取消（纯累加器，无目标跟踪）。
  pendingScrollDelta?: number
  // 虚拟滚动的渲染时钳位边界。useVirtualScroll 写入
  // 当前挂载的子节点覆盖范围；render-node-to-output
  // 钳位 scrollTop 以保持在其范围内。防止当
  // scrollTo 的直接写入超过 React 的异步重新渲染时出现空白屏幕 —
  // 渲染器会保持在挂载内容的边缘，直到 React 跟上
  // （下一次提交更新这些边界并释放钳位）。Undefined = 无钳位（sticky-scroll，冷启动）。
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  /**
   * 内容高度高水位（对齐 CC scrollHeightHwm）。
   * 流式/虚拟化时 scrollHeight 可能短暂回落；HWM 用于触底跟随时
   * 避免「高度缩水 → 误判离底 → transcript 回跳」。
   * 用户主动上滚时由 ScrollBox 清除。
   */
  scrollHeightHwm?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  // 由 ScrollBox.scrollToElement 设置；render-node-to-output 读取
  // el.yogaNode.getComputedTop()（新鲜的 — 与 scrollHeight 同一次 Yoga 传递）
  // 并设置 scrollTop = top + offset，然后清除此值。与命令式
  // scrollTo(N) 不同，后者 bake 了一个到渲染触发时已过时的数字，
  // 元素引用将位置读取延迟到绘制时间。一次性。
  scrollAnchor?: { el: DOMElement; offset: number }
  // 仅在 ink-root 上设置。文档拥有 focus — 任何节点都可以
  // 通过 walking parentNode 访问它，就像浏览器的 getRootNode()。
  focusManager?: FocusManager
  // 在创建实例时（reconciler.ts）捕获的 React 组件栈，
  // 例如 ['ToolUseLoader', 'Messages', 'REPL']。仅在
  // 设置 ZY_CODE_DEBUG_REPAINTS 时填充。由 findOwnerChainAtRow 使用，
  // 用于将 scrollback-diff 全量重置归因于导致它们的组件。
  debugOwnerChain?: string[]
} & InkNode

export type TextNode = {
  nodeName: TextName
  nodeValue: string
} & InkNode

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNode<T = { nodeName: NodeNames }> = T extends {
  nodeName: infer U
}
  ? U extends '#text'
    ? TextNode
    : DOMElement
  : never

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNodeAttribute = boolean | string | number

export const createNode = (nodeName: ElementNames): DOMElement => {
  const needsYogaNode =
    nodeName !== 'ink-virtual-text' && nodeName !== 'ink-link' && nodeName !== 'ink-progress'
  const node: DOMElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? createLayoutNode() : undefined,
    dirty: false,
  }

  if (nodeName === 'ink-text') {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node))
  } else if (nodeName === 'ink-raw-ansi') {
    node.yogaNode?.setMeasureFunc(measureRawAnsiNode.bind(null, node))
  }

  return node
}

export const appendChildNode = (node: DOMElement, childNode: DOMElement): void => {
  if (childNode.parentNode) {
    removeChildNode(childNode.parentNode, childNode)
  }

  childNode.parentNode = node
  node.childNodes.push(childNode)

  if (childNode.yogaNode) {
    node.yogaNode?.insertChild(childNode.yogaNode, node.yogaNode.getChildCount())
  }

  markDirty(node)
}

export const insertBeforeNode = (
  node: DOMElement,
  newChildNode: DOMNode,
  beforeChildNode: DOMNode,
): void => {
  if (newChildNode.parentNode) {
    removeChildNode(newChildNode.parentNode, newChildNode)
  }

  newChildNode.parentNode = node

  const index = node.childNodes.indexOf(beforeChildNode)

  if (index >= 0) {
    // 计算 yoga 索引 BEFORE 修改 childNodes。
    // 不能直接使用 DOM 索引，因为某些子节点（如 ink-progress、
    // ink-link、ink-virtual-text）没有 yogaNodes，所以 DOM 索引与
    // yoga 索引不匹配。
    let yogaIndex = 0
    if (newChildNode.yogaNode && node.yogaNode) {
      for (let i = 0; i < index; i++) {
        if (node.childNodes[i]?.yogaNode) {
          yogaIndex++
        }
      }
    }

    node.childNodes.splice(index, 0, newChildNode)

    if (newChildNode.yogaNode && node.yogaNode) {
      node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex)
    }

    markDirty(node)
    return
  }

  node.childNodes.push(newChildNode)

  if (newChildNode.yogaNode) {
    node.yogaNode?.insertChild(newChildNode.yogaNode, node.yogaNode.getChildCount())
  }

  markDirty(node)
}

export let removeChildNode: (node: DOMElement, removeNode: DOMNode) => void
removeChildNode = (node: DOMElement, removeNode: DOMNode): void => {
  if (removeNode.yogaNode) {
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode)
  }

  // 从移除的子树中收集缓存的矩形，以便清除它们
  collectRemovedRects(node, removeNode)

  removeNode.parentNode = undefined

  const index = node.childNodes.indexOf(removeNode)
  if (index >= 0) {
    node.childNodes.splice(index, 1)
  }

  markDirty(node)
}

function collectRemovedRects(parent: DOMElement, removed: DOMNode, underAbsolute = false): void {
  if (removed.nodeName === '#text') {
    return
  }
  const elem = removed as DOMElement
  // 如果此节点或被移除子树中的任何祖先节点是 absolute，
  // 其绘制的像素可能与非兄弟节点重叠 — 标记为全局 blit
  // 禁用。普通流的移除只影响直接兄弟节点，
  // hasRemovedChild 已处理此问题。
  const isAbsolute = underAbsolute || elem.style.position === 'absolute'
  const cached = nodeCache.get(elem)
  if (cached) {
    addPendingClear(parent, cached, isAbsolute)
    nodeCache.delete(elem)
  }
  for (const child of elem.childNodes) {
    collectRemovedRects(parent, child, isAbsolute)
  }
}

export const setAttribute = (node: DOMElement, key: string, value: DOMNodeAttribute): void => {
  // 跳过 'children' — React 通过 appendChild/removeChild 处理子节点，
  // 而不是通过 attributes。React 总是传递新的 children 引用，所以
  // 将其作为属性跟踪会导致每次渲染都将所有内容标记为 dirty。
  if (key === 'children') {
    return
  }
  // 如果值未变化则跳过
  if (node.attributes[key] === value) {
    return
  }
  node.attributes[key] = value
  markDirty(node)
}

export const setStyle = (node: DOMNode, style: Styles): void => {
  // 比较样式属性以避免不必要地标记 dirty。
  // React 在每次渲染时都会创建新的样式对象，即使未变化。
  if (stylesEqual(node.style, style)) {
    return
  }
  node.style = style
  markDirty(node)
}

export const setTextStyles = (node: DOMElement, textStyles: TextStyles): void => {
  // 与 setStyle 相同的 dirty 检查守卫：React（以及 Text.tsx 中的 buildTextStyles）
  // 在每次渲染时都会分配新的 textStyles 对象，即使值未变化，
  // 所以按值比较以避免在每次 Text 重新渲染时 markDirty -> yoga 重新测量。
  if (shallowEqual(node.textStyles, textStyles)) {
    return
  }
  node.textStyles = textStyles
  markDirty(node)
}

function stylesEqual(a: Styles, b: Styles): boolean {
  return shallowEqual(a, b)
}

function shallowEqual<T extends object>(a: T | undefined, b: T | undefined): boolean {
  // 快速路径：相同对象引用（或两者都是 undefined）
  if (a === b) {
    return true
  }
  if (a === undefined || b === undefined) {
    return false
  }

  // 获取两个对象的所有键
  const aKeys = Object.keys(a) as (keyof T)[]
  const bKeys = Object.keys(b) as (keyof T)[]

  // 属性数量不同
  if (aKeys.length !== bKeys.length) {
    return false
  }

  // 比较每个属性
  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      return false
    }
  }

  return true
}

export const createTextNode = (text: string): TextNode => {
  const node: TextNode = {
    nodeName: '#text',
    nodeValue: text,
    yogaNode: undefined,
    parentNode: undefined,
    style: {},
  }

  setTextNodeValue(node, text)

  return node
}

let measureTextNode: (
  node: DOMNode,
  width: number,
  widthMode: LayoutMeasureMode,
) => { width: number; height: number }
measureTextNode = (
  node: DOMNode,
  width: number,
  widthMode: LayoutMeasureMode,
): { width: number; height: number } => {
  const rawText = node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node)

  // 展开制表符用于测量（最坏情况：每个 8 个空格）。
  // 实际的制表符展开在 output.ts 中根据屏幕位置进行。
  const text = expandTabs(rawText)

  const dimensions = measureText(text, width)

  // 文本适应容器，无需换行
  if (dimensions.width <= width) {
    return dimensions
  }

  // 当 <Box> 缩小子节点且布局询问
  // 我们能否将此文本节点放入 <1px 空间时发生，所以我们直接说"不"
  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions
  }

  // 对于包含嵌入换行符的文本（预包裹内容），避免在测量宽度时重新换行
  // 当布局询问固有大小时（Undefined 模式）。
  // 这防止了在最小/最大尺寸检查期间高度膨胀。
  //
  // 但是，当布局提供实际约束时（Exactly 或 AtMost 模式），
  // 我们必须尊重它并在该宽度下测量。否则，如果实际
  // 渲染宽度小于自然宽度，文本将换行到
  // 比布局预期更多的行，导致内容被截断。
  if (text.includes('\n') && widthMode === LayoutMeasureMode.Undefined) {
    const effectiveWidth = Math.max(width, dimensions.width)
    return measureText(text, effectiveWidth)
  }

  const textWrap = node.style?.textWrap ?? 'wrap'
  const wrappedText = wrapText(text, width, textWrap)

  return measureText(wrappedText, width)
}

// ink-raw-ansi 节点保存预渲染的 ANSI 字符串及其已知尺寸。
// 无需 stringWidth、无需换行、无需制表符展开 — 生产者（例如 ColorDiff）
// 已经以目标宽度包裹，每行正好是一个终端行。
let measureRawAnsiNode: (node: DOMElement) => { width: number; height: number }
measureRawAnsiNode = (
  node: DOMElement,
): {
  width: number
  height: number
} => ({
  width: node.attributes.rawWidth as number,
  height: node.attributes.rawHeight as number,
})

/**
 * 将节点及其所有祖先节点标记为 dirty 以进行重新渲染。
 * 如果是文本节点，还会标记 yoga dirty 以进行文本重新测量。
 */
export let markDirty: (node?: DOMNode) => void
markDirty = (node?: DOMNode): void => {
  let current: DOMNode | undefined = node
  let markedYoga = false

  while (current) {
    if (current.nodeName !== '#text') {
      ;(current as DOMElement).dirty = true
      // 仅在具有测量函数的叶节点上标记 yoga dirty
      if (
        !markedYoga &&
        (current.nodeName === 'ink-text' || current.nodeName === 'ink-raw-ansi') &&
        current.yogaNode
      ) {
        current.yogaNode.markDirty()
        markedYoga = true
      }
    }
    current = current.parentNode
  }
}

// 遍历到根节点并调用其 onRender（节流 scheduleRender）。用于
// DOM 级突变（scrollTop 变化）应该触发 Ink 帧
// 而无需经过 React 的协调器。与 markDirty() 配对使用，这样
// 渲染器知道要重新评估哪个子树。
export const scheduleRenderFrom = (node?: DOMNode): void => {
  let cur: DOMNode | undefined = node
  while (cur?.parentNode) {
    cur = cur.parentNode
  }
  if (cur && cur.nodeName !== '#text') {
    ;(cur as DOMElement).onRender?.()
  }
}

export let setTextNodeValue: (node: TextNode, text: string) => void
setTextNodeValue = (node: TextNode, text: string): void => {
  if (typeof text !== 'string') {
    text = String(text)
  }

  // 如果值未变化则跳过
  if (node.nodeValue === text) {
    return
  }

  node.nodeValue = text
  markDirty(node)
}

function isDOMElement(node: DOMElement | TextNode): node is DOMElement {
  return node.nodeName !== '#text'
}

// 在释放之前递归清除 yogaNode 引用。
// freeRecursive() 释放节点及其 ALL 子节点，所以我们必须清除
// 所有 yogaNode 引用以防止悬空指针。
export const clearYogaNodeReferences = (node: DOMElement | TextNode): void => {
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      clearYogaNodeReferences(child)
    }
  }
  node.yogaNode = undefined
}

/**
 * 查找负责屏幕行 `y` 处内容的 React 组件栈。
 *
 * DFS 遍历 DOM 树累加 yoga 偏移量。返回其边界框包含 `y` 的
 * 最深节点的 debugOwnerChain。当
 * log-update 触发全量重置时从 ink.tsx 调用，用于将闪烁归因于其来源。
 *
 * 仅在设置 ZY_CODE_DEBUG_REPAINTS 时有用（否则 chains 为
 * undefined 并且此函数返回 []）。
 */
export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  let best: string[] = []
  walk(root, 0)
  return best

  function walk(node: DOMElement, offsetY: number): void {
    const yoga = node.yogaNode
    if (!yoga || yoga.getDisplay() === LayoutDisplay.None) {
      return
    }

    const top = offsetY + yoga.getComputedTop()
    const height = yoga.getComputedHeight()
    if (y < top || y >= top + height) {
      return
    }

    if (node.debugOwnerChain) {
      best = node.debugOwnerChain
    }

    for (const child of node.childNodes) {
      if (isDOMElement(child)) {
        walk(child, top)
      }
    }
  }
}
