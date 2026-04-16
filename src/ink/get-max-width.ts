import { LayoutEdge, type LayoutNode } from './layout/node.js'

/**
 * 获取 yoga 节点的内容宽度（计算宽度减去 padding 和 border）。
 *
 * 警告：返回值可能比父容器更宽。在 column 方向的 flex 父容器中，
 * 宽度是交叉轴——align-items: stretch 不会将子元素缩小到低于其
 * 固有尺寸，因此文本节点会溢出（标准 CSS 行为）。Yoga 分两遍测量
 * 叶子节点：AtMost 遍确定宽度，Exactly 遍确定高度。
 * getComputedWidth() 反映较宽的 AtMost 结果，而 getComputedHeight()
 * 反映较窄的 Exactly 结果。使用此值做换行的调用者应将其裁剪到实际
 * 可用屏幕空间，以使渲染行数与布局高度保持一致。
 */
const getMaxWidth = (yogaNode: LayoutNode): number => {
  return (
    yogaNode.getComputedWidth() -
    yogaNode.getComputedPadding(LayoutEdge.Left) -
    yogaNode.getComputedPadding(LayoutEdge.Right) -
    yogaNode.getComputedBorder(LayoutEdge.Left) -
    yogaNode.getComputedBorder(LayoutEdge.Right)
  )
}

export default getMaxWidth
