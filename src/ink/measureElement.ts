import type { DOMElement } from './dom.js'

type Output = {
  /**
   * 元素宽度。
   */
  width: number

  /**
   * 元素高度。
   */
  height: number
}

/**
 * 测量指定 `<Box>` 元素的尺寸。
 */
const measureElement = (node: DOMElement): Output => ({
  width: node.yogaNode?.getComputedWidth() ?? 0,
  height: node.yogaNode?.getComputedHeight() ?? 0,
})

export default measureElement
