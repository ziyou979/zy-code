import type { DOMElement } from './dom.js'
import type { TextStyles } from './styles.js'

/**
 * 带有样式的文本片段。
 * 用于结构化渲染，无需 ANSI 字符串转换。
 */
export type StyledSegment = {
  text: string
  styles: TextStyles
  hyperlink?: string
}

/**
 * 将文本节点压缩为带样式的片段，将样式向下传播到整个树中。
 * 这样可以实现结构化样式，而无需依赖 ANSI 字符串转换。
 */
export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles: TextStyles = {},
  inheritedHyperlink?: string,
  out: StyledSegment[] = [],
): StyledSegment[] {
  const mergedStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      if (childNode.nodeValue.length > 0) {
        out.push({
          text: childNode.nodeValue,
          styles: mergedStyles,
          hyperlink: inheritedHyperlink,
        })
      }
    } else if (childNode.nodeName === 'ink-text' || childNode.nodeName === 'ink-virtual-text') {
      squashTextNodesToSegments(childNode, mergedStyles, inheritedHyperlink, out)
    } else if (childNode.nodeName === 'ink-link') {
      const href = childNode.attributes['href'] as string | undefined
      squashTextNodesToSegments(childNode, mergedStyles, href || inheritedHyperlink, out)
    }
  }

  return out
}

/**
 * 将文本节点压缩为纯字符串（不含样式）。
 * 用于布局计算中的文本测量。
 */
function squashTextNodes(node: DOMElement): string {
  let text = ''

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      text += childNode.nodeValue
    } else if (childNode.nodeName === 'ink-text' || childNode.nodeName === 'ink-virtual-text') {
      text += squashTextNodes(childNode)
    } else if (childNode.nodeName === 'ink-link') {
      text += squashTextNodes(childNode)
    }
  }

  return text
}

export default squashTextNodes
