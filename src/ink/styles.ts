import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  type LayoutNode,
  LayoutOverflow,
  LayoutPositionType,
  LayoutWrap,
} from './layout/node.js'
import type { BorderStyle, BorderTextOptions } from './render-border.js'

export type RGBColor = `rgb(${number},${number},${number})`
export type HexColor = `#${string}`
export type Ansi256Color = `ansi256(${number})`
export type AnsiColor =
  | 'ansi:black'
  | 'ansi:red'
  | 'ansi:green'
  | 'ansi:yellow'
  | 'ansi:blue'
  | 'ansi:magenta'
  | 'ansi:cyan'
  | 'ansi:white'
  | 'ansi:blackBright'
  | 'ansi:redBright'
  | 'ansi:greenBright'
  | 'ansi:yellowBright'
  | 'ansi:blueBright'
  | 'ansi:magentaBright'
  | 'ansi:cyanBright'
  | 'ansi:whiteBright'

/** 原始颜色值 —— 非主题 key */
export type Color = RGBColor | HexColor | Ansi256Color | AnsiColor

/**
 * 结构化的文本样式属性。
 * 用于在不依赖 ANSI 字符串转换的情况下设置文本样式。
 * 颜色为原始值 —— 在组件层解析主题。
 */
export type TextStyles = {
  readonly color?: Color
  readonly backgroundColor?: Color
  readonly dim?: boolean
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
}

export type Styles = {
  readonly textWrap?:
    | 'wrap'
    | 'wrap-trim'
    | 'end'
    | 'middle'
    | 'truncate-end'
    | 'truncate'
    | 'truncate-middle'
    | 'truncate-start'

  readonly position?: 'absolute' | 'relative'
  readonly top?: number | `${number}%`
  readonly bottom?: number | `${number}%`
  readonly left?: number | `${number}%`
  readonly right?: number | `${number}%`

  /**
   * 元素列之间的间距大小。
   */
  readonly columnGap?: number

  /**
   * 元素行之间的间距大小。
   */
  readonly rowGap?: number

  /**
   * 元素列和行之间的间距大小。`columnGap` 和 `rowGap` 的简写。
   */
  readonly gap?: number

  /**
   * 四边外边距。等价于同时设置 `marginTop`、`marginBottom`、`marginLeft` 和 `marginRight`。
   */
  readonly margin?: number

  /**
   * 水平外边距。等价于同时设置 `marginLeft` 和 `marginRight`。
   */
  readonly marginX?: number

  /**
   * 垂直外边距。等价于同时设置 `marginTop` 和 `marginBottom`。
   */
  readonly marginY?: number

  /**
   * 上外边距。
   */
  readonly marginTop?: number

  /**
   * 下外边距。
   */
  readonly marginBottom?: number

  /**
   * 左外边距。
   */
  readonly marginLeft?: number

  /**
   * 右外边距。
   */
  readonly marginRight?: number

  /**
   * 四边内边距。等价于同时设置 `paddingTop`、`paddingBottom`、`paddingLeft` 和 `paddingRight`。
   */
  readonly padding?: number

  /**
   * 水平内边距。等价于同时设置 `paddingLeft` 和 `paddingRight`。
   */
  readonly paddingX?: number

  /**
   * 垂直内边距。等价于同时设置 `paddingTop` 和 `paddingBottom`。
   */
  readonly paddingY?: number

  /**
   * 上内边距。
   */
  readonly paddingTop?: number

  /**
   * 下内边距。
   */
  readonly paddingBottom?: number

  /**
   * 左内边距。
   */
  readonly paddingLeft?: number

  /**
   * 右内边距。
   */
  readonly paddingRight?: number

  /**
   * 定义 flex 项目在必要时增长的能力。
   * 参见 [flex-grow](https://css-tricks.com/almanac/properties/f/flex-grow/)。
   */
  readonly flexGrow?: number

  /**
   * 指定 “flex 收缩系数”，决定 flex 项目在行空间不足时相对于容器中其他 flex 项目的收缩程度。
   * 参见 [flex-shrink](https://css-tricks.com/almanac/properties/f/flex-shrink/)。
   */
  readonly flexShrink?: number

  /**
   * 建立主轴，从而定义 flex 项目在 flex 容器中的排列方向。
   * 参见 [flex-direction](https://css-tricks.com/almanac/properties/f/flex-direction/)。
   */
  readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'

  /**
   * 指定 flex 项目的初始大小，在任何可用空间根据 flex 系数分配之前。
   * 参见 [flex-basis](https://css-tricks.com/almanac/properties/f/flex-basis/)。
   */
  readonly flexBasis?: number | string

  /**
   * 定义 flex 项目是强制排列在单行还是可以流入多行。如果设置为多行，还定义交叉轴方向，决定新行的堆叠方向。
   * 参见 [flex-wrap](https://css-tricks.com/almanac/properties/f/flex-wrap/)。
   */
  readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'

  /**
   * align-items 属性定义了项目在交叉轴（垂直于主轴）上的默认对齐方式。
   * 参见 [align-items](https://css-tricks.com/almanac/properties/a/align-items/)。
   */
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'

  /**
   * 允许为特定 flex 项目覆盖 align-items 的值。
   * 参见 [align-self](https://css-tricks.com/almanac/properties/a/align-self/)。
   */
  readonly alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto'

  /**
   * 定义项目在主轴上的对齐方式。
   * 参见 [justify-content](https://css-tricks.com/almanac/properties/j/justify-content/)。
   */
  readonly justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
    | 'center'

  /**
   * 元素的宽度（以空格数为单位）。
   * 也可以设置为百分比，将根据父元素的宽度计算。
   */
  readonly width?: number | string

  /**
   * 元素的高度（以行数为准）。
   * 也可以设置为百分比，将根据父元素的高度计算。
   */
  readonly height?: number | string

  /**
   * 设置元素的最小宽度。
   */
  readonly minWidth?: number | string

  /**
   * 设置元素的最小高度。
   */
  readonly minHeight?: number | string

  /**
   * 设置元素的最大宽度。
   */
  readonly maxWidth?: number | string

  /**
   * 设置元素的最大高度。
   */
  readonly maxHeight?: number | string

  /**
   * 将此属性设置为 `none` 以隐藏元素。
   */
  readonly display?: 'flex' | 'none'

  /**
   * 为边框添加指定样式。
   * 如果 `borderStyle` 为 `undefined`（默认值），则不添加边框。
   */
  readonly borderStyle?: BorderStyle

  /**
   * 决定上边框是否可见。
   *
   * @default true
   */
  readonly borderTop?: boolean

  /**
   * 决定下边框是否可见。
   *
   * @default true
   */
  readonly borderBottom?: boolean

  /**
   * 决定左边框是否可见。
   *
   * @default true
   */
  readonly borderLeft?: boolean

  /**
   * 决定右边框是否可见。
   *
   * @default true
   */
  readonly borderRight?: boolean

  /**
   * 修改边框颜色。设置 `borderTopColor`、`borderRightColor`、`borderBottomColor` 和 `borderLeftColor` 的简写。
   */
  readonly borderColor?: Color

  /**
   * 修改上边框颜色。接受原始颜色值（rgb、hex、ansi）。
   */
  readonly borderTopColor?: Color

  /**
   * 修改下边框颜色。接受原始颜色值（rgb、hex、ansi）。
   */
  readonly borderBottomColor?: Color

  /**
   * 修改左边框颜色。接受原始颜色值（rgb、hex、ansi）。
   */
  readonly borderLeftColor?: Color

  /**
   * 修改右边框颜色。接受原始颜色值（rgb、hex、ansi）。
   */
  readonly borderRightColor?: Color

  /**
   * 淡化边框颜色。设置 `borderTopDimColor`、`borderBottomDimColor`、`borderLeftDimColor` 和 `borderRightDimColor` 的简写。
   *
   * @default false
   */
  readonly borderDimColor?: boolean

  /**
   * 淡化上边框颜色。
   *
   * @default false
   */
  readonly borderTopDimColor?: boolean

  /**
   * 淡化下边框颜色。
   *
   * @default false
   */
  readonly borderBottomDimColor?: boolean

  /**
   * 淡化左边框颜色。
   *
   * @default false
   */
  readonly borderLeftDimColor?: boolean

  /**
   * 淡化右边框颜色。
   *
   * @default false
   */
  readonly borderRightDimColor?: boolean

  /**
   * 在边框内添加文本。仅适用于上边框或下边框。
   */
  readonly borderText?: BorderTextOptions

  /**
   * 盒子的背景色。用背景色的空格填充内部区域，
   * 子文本节点将其作为默认背景继承。
   */
  readonly backgroundColor?: Color

  /**
   * 在渲染子元素之前，用空格填充盒子内部（包括 padding 区域），
   * 使后方的内容不会透出。类似于 `backgroundColor`，
   * 但不发射任何 SGR —— 使用终端的默认背景。适用于绝对定位的覆盖层，
   * 此时 Box 的 padding/gap 默认是透明的。
   */
  readonly opaque?: boolean

  /**
   * 元素在两个方向上的溢出行为。
   * 'scroll' 会限制容器大小（子元素不会撑大容器），
   * 并在渲染时启用基于 scrollTop 的虚拟滚动。
   *
   * @default 'visible'
   */
  readonly overflow?: 'visible' | 'hidden' | 'scroll'

  /**
   * 元素在水平方向上的溢出行为。
   *
   * @default 'visible'
   */
  readonly overflowX?: 'visible' | 'hidden' | 'scroll'

  /**
   * 元素在垂直方向上的溢出行为。
   *
   * @default 'visible'
   */
  readonly overflowY?: 'visible' | 'hidden' | 'scroll'

  /**
   * 在全屏模式下，将此盒子的单元格排除在文本选择之外。
   * 该区域内的单元格会被选择高亮和复制文本跳过 —— 用于隔离边栏（行号、
   * diff 标记），这样在 diff 上拖拽选择可以得到干净可复制的代码。
   * 仅影响 alt-screen 文本选择；其他场景无效果。
   *
   * `'from-left-edge'` 从第 0 列延伸到盒子的右边缘，覆盖其占据的每一行
   * —— 这会覆盖任何上游缩进（工具消息前缀、树形连线），
   * 使得多行拖拽不会在中间行选中前导空白。
   */
  readonly noSelect?: boolean | 'from-left-edge'
}

const applyPositionStyles = (node: LayoutNode, style: Styles): void => {
  if ('position' in style) {
    node.setPositionType(
      style.position === 'absolute' ? LayoutPositionType.Absolute : LayoutPositionType.Relative,
    )
  }
  if ('top' in style) applyPositionEdge(node, 'top', style.top)
  if ('bottom' in style) applyPositionEdge(node, 'bottom', style.bottom)
  if ('left' in style) applyPositionEdge(node, 'left', style.left)
  if ('right' in style) applyPositionEdge(node, 'right', style.right)
}

function applyPositionEdge(
  node: LayoutNode,
  edge: 'top' | 'bottom' | 'left' | 'right',
  v: number | `${number}%` | undefined,
): void {
  if (typeof v === 'string') {
    node.setPositionPercent(edge, Number.parseInt(v, 10))
  } else if (typeof v === 'number') {
    node.setPosition(edge, v)
  } else {
    node.setPosition(edge, Number.NaN)
  }
}

const applyOverflowStyles = (node: LayoutNode, style: Styles): void => {
  // Yoga 的 Overflow 控制子元素是否会撑大容器。
  // 'hidden' 和 'scroll' 都阻止撑大；'scroll' 还额外
  // 向渲染器发出信号，应用 scrollTop 偏移。
  // overflowX/Y 是渲染时的考虑；对于布局，使用两者的并集。
  const y = style.overflowY ?? style.overflow
  const x = style.overflowX ?? style.overflow
  if (y === 'scroll' || x === 'scroll') {
    node.setOverflow(LayoutOverflow.Scroll)
  } else if (y === 'hidden' || x === 'hidden') {
    node.setOverflow(LayoutOverflow.Hidden)
  } else if ('overflow' in style || 'overflowX' in style || 'overflowY' in style) {
    node.setOverflow(LayoutOverflow.Visible)
  }
}

const applyMarginStyles = (node: LayoutNode, style: Styles): void => {
  if ('margin' in style) {
    node.setMargin(LayoutEdge.All, style.margin ?? 0)
  }

  if ('marginX' in style) {
    node.setMargin(LayoutEdge.Horizontal, style.marginX ?? 0)
  }

  if ('marginY' in style) {
    node.setMargin(LayoutEdge.Vertical, style.marginY ?? 0)
  }

  if ('marginLeft' in style) {
    node.setMargin(LayoutEdge.Start, style.marginLeft || 0)
  }

  if ('marginRight' in style) {
    node.setMargin(LayoutEdge.End, style.marginRight || 0)
  }

  if ('marginTop' in style) {
    node.setMargin(LayoutEdge.Top, style.marginTop || 0)
  }

  if ('marginBottom' in style) {
    node.setMargin(LayoutEdge.Bottom, style.marginBottom || 0)
  }
}

const applyPaddingStyles = (node: LayoutNode, style: Styles): void => {
  if ('padding' in style) {
    node.setPadding(LayoutEdge.All, style.padding ?? 0)
  }

  if ('paddingX' in style) {
    node.setPadding(LayoutEdge.Horizontal, style.paddingX ?? 0)
  }

  if ('paddingY' in style) {
    node.setPadding(LayoutEdge.Vertical, style.paddingY ?? 0)
  }

  if ('paddingLeft' in style) {
    node.setPadding(LayoutEdge.Left, style.paddingLeft || 0)
  }

  if ('paddingRight' in style) {
    node.setPadding(LayoutEdge.Right, style.paddingRight || 0)
  }

  if ('paddingTop' in style) {
    node.setPadding(LayoutEdge.Top, style.paddingTop || 0)
  }

  if ('paddingBottom' in style) {
    node.setPadding(LayoutEdge.Bottom, style.paddingBottom || 0)
  }
}

const applyFlexStyles = (node: LayoutNode, style: Styles): void => {
  if ('flexGrow' in style) {
    node.setFlexGrow(style.flexGrow ?? 0)
  }

  if ('flexShrink' in style) {
    node.setFlexShrink(typeof style.flexShrink === 'number' ? style.flexShrink : 1)
  }

  if ('flexWrap' in style) {
    if (style.flexWrap === 'nowrap') {
      node.setFlexWrap(LayoutWrap.NoWrap)
    }

    if (style.flexWrap === 'wrap') {
      node.setFlexWrap(LayoutWrap.Wrap)
    }

    if (style.flexWrap === 'wrap-reverse') {
      node.setFlexWrap(LayoutWrap.WrapReverse)
    }
  }

  if ('flexDirection' in style) {
    if (style.flexDirection === 'row') {
      node.setFlexDirection(LayoutFlexDirection.Row)
    }

    if (style.flexDirection === 'row-reverse') {
      node.setFlexDirection(LayoutFlexDirection.RowReverse)
    }

    if (style.flexDirection === 'column') {
      node.setFlexDirection(LayoutFlexDirection.Column)
    }

    if (style.flexDirection === 'column-reverse') {
      node.setFlexDirection(LayoutFlexDirection.ColumnReverse)
    }
  }

  if ('flexBasis' in style) {
    if (typeof style.flexBasis === 'number') {
      node.setFlexBasis(style.flexBasis)
    } else if (typeof style.flexBasis === 'string') {
      node.setFlexBasisPercent(Number.parseInt(style.flexBasis, 10))
    } else {
      node.setFlexBasis(Number.NaN)
    }
  }

  if ('alignItems' in style) {
    if (style.alignItems === 'stretch' || !style.alignItems) {
      node.setAlignItems(LayoutAlign.Stretch)
    }

    if (style.alignItems === 'flex-start') {
      node.setAlignItems(LayoutAlign.FlexStart)
    }

    if (style.alignItems === 'center') {
      node.setAlignItems(LayoutAlign.Center)
    }

    if (style.alignItems === 'flex-end') {
      node.setAlignItems(LayoutAlign.FlexEnd)
    }
  }

  if ('alignSelf' in style) {
    if (style.alignSelf === 'auto' || !style.alignSelf) {
      node.setAlignSelf(LayoutAlign.Auto)
    }

    if (style.alignSelf === 'flex-start') {
      node.setAlignSelf(LayoutAlign.FlexStart)
    }

    if (style.alignSelf === 'center') {
      node.setAlignSelf(LayoutAlign.Center)
    }

    if (style.alignSelf === 'flex-end') {
      node.setAlignSelf(LayoutAlign.FlexEnd)
    }
  }

  if ('justifyContent' in style) {
    if (style.justifyContent === 'flex-start' || !style.justifyContent) {
      node.setJustifyContent(LayoutJustify.FlexStart)
    }

    if (style.justifyContent === 'center') {
      node.setJustifyContent(LayoutJustify.Center)
    }

    if (style.justifyContent === 'flex-end') {
      node.setJustifyContent(LayoutJustify.FlexEnd)
    }

    if (style.justifyContent === 'space-between') {
      node.setJustifyContent(LayoutJustify.SpaceBetween)
    }

    if (style.justifyContent === 'space-around') {
      node.setJustifyContent(LayoutJustify.SpaceAround)
    }

    if (style.justifyContent === 'space-evenly') {
      node.setJustifyContent(LayoutJustify.SpaceEvenly)
    }
  }
}

const applyDimensionStyles = (node: LayoutNode, style: Styles): void => {
  if ('width' in style) {
    if (typeof style.width === 'number') {
      node.setWidth(style.width)
    } else if (typeof style.width === 'string') {
      node.setWidthPercent(Number.parseInt(style.width, 10))
    } else {
      node.setWidthAuto()
    }
  }

  if ('height' in style) {
    if (typeof style.height === 'number') {
      node.setHeight(style.height)
    } else if (typeof style.height === 'string') {
      node.setHeightPercent(Number.parseInt(style.height, 10))
    } else {
      node.setHeightAuto()
    }
  }

  if ('minWidth' in style) {
    if (typeof style.minWidth === 'string') {
      node.setMinWidthPercent(Number.parseInt(style.minWidth, 10))
    } else {
      node.setMinWidth(style.minWidth ?? 0)
    }
  }

  if ('minHeight' in style) {
    if (typeof style.minHeight === 'string') {
      node.setMinHeightPercent(Number.parseInt(style.minHeight, 10))
    } else {
      node.setMinHeight(style.minHeight ?? 0)
    }
  }

  if ('maxWidth' in style) {
    if (typeof style.maxWidth === 'string') {
      node.setMaxWidthPercent(Number.parseInt(style.maxWidth, 10))
    } else {
      node.setMaxWidth(style.maxWidth ?? 0)
    }
  }

  if ('maxHeight' in style) {
    if (typeof style.maxHeight === 'string') {
      node.setMaxHeightPercent(Number.parseInt(style.maxHeight, 10))
    } else {
      node.setMaxHeight(style.maxHeight ?? 0)
    }
  }
}

const applyDisplayStyles = (node: LayoutNode, style: Styles): void => {
  if ('display' in style) {
    node.setDisplay(style.display === 'flex' ? LayoutDisplay.Flex : LayoutDisplay.None)
  }
}

const applyBorderStyles = (node: LayoutNode, style: Styles, resolvedStyle?: Styles): void => {
  // resolvedStyle 是完整的当前样式（已设置在 DOM 节点上）。
  // style 可能是一个只包含变更属性的 diff。对于边框侧边属性，
  // 我们需要解析后的值，因为 diff 中的 `borderStyle` 可能不包含
  // 未变更的边框侧值（例如 borderTop 保持 false 但不在 diff 中）。
  const resolved = resolvedStyle ?? style

  if ('borderStyle' in style) {
    const borderWidth = style.borderStyle ? 1 : 0

    node.setBorder(LayoutEdge.Top, resolved.borderTop !== false ? borderWidth : 0)
    node.setBorder(LayoutEdge.Bottom, resolved.borderBottom !== false ? borderWidth : 0)
    node.setBorder(LayoutEdge.Left, resolved.borderLeft !== false ? borderWidth : 0)
    node.setBorder(LayoutEdge.Right, resolved.borderRight !== false ? borderWidth : 0)
  } else {
    // 处理单个边框属性的变更（仅修改 borderX 而不修改 borderStyle 时）。
    // 跳过 undefined 值 —— 它们表示属性被移除或从未设置，
    // 而不是应该启用边框。
    if ('borderTop' in style && style.borderTop !== undefined) {
      node.setBorder(LayoutEdge.Top, style.borderTop === false ? 0 : 1)
    }
    if ('borderBottom' in style && style.borderBottom !== undefined) {
      node.setBorder(LayoutEdge.Bottom, style.borderBottom === false ? 0 : 1)
    }
    if ('borderLeft' in style && style.borderLeft !== undefined) {
      node.setBorder(LayoutEdge.Left, style.borderLeft === false ? 0 : 1)
    }
    if ('borderRight' in style && style.borderRight !== undefined) {
      node.setBorder(LayoutEdge.Right, style.borderRight === false ? 0 : 1)
    }
  }
}

const applyGapStyles = (node: LayoutNode, style: Styles): void => {
  if ('gap' in style) {
    node.setGap(LayoutGutter.All, style.gap ?? 0)
  }

  if ('columnGap' in style) {
    node.setGap(LayoutGutter.Column, style.columnGap ?? 0)
  }

  if ('rowGap' in style) {
    node.setGap(LayoutGutter.Row, style.rowGap ?? 0)
  }
}

const styles = (node: LayoutNode, style: Styles = {}, resolvedStyle?: Styles): void => {
  applyPositionStyles(node, style)
  applyOverflowStyles(node, style)
  applyMarginStyles(node, style)
  applyPaddingStyles(node, style)
  applyFlexStyles(node, style)
  applyDimensionStyles(node, style)
  applyDisplayStyles(node, style)
  applyBorderStyles(node, style, resolvedStyle)
  applyGapStyles(node, style)
}

export default styles
