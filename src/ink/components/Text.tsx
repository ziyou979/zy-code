import type { ReactNode } from 'react'
import React from 'react'
import type { Color, Styles } from '../styles.js'

type BaseProps = {
  /**
   * 更改文本颜色。接受原始颜色值（rgb、hex、ansi）。
   */
  readonly color?: Color

  /**
   * 与 `color` 类似，但用于背景色。
   */
  readonly backgroundColor?: Color

  /**
   * 使文本倾斜。
   */
  readonly italic?: boolean

  /**
   * 使文本带下划线。
   */
  readonly underline?: boolean

  /**
   * 使文本带删除线。
   */
  readonly strikethrough?: boolean

  /**
   * 反转前景色和背景色。
   */
  readonly inverse?: boolean

  /**
   * 此属性告诉 Ink 在文本宽度超过容器时进行换行或截断。
   * 如果传入 `wrap`（默认），Ink 将换行并拆分为多行。
   * 如果传入 `truncate-*`，Ink 将截断文本，结果为单行文本，其余部分被裁剪。
   */
  readonly wrap?: Styles['textWrap']
  /**
   * 保留仅由空白组成的文本。用于原生光标占用的尾随单元格。
   */
  readonly 'aria-preserve-whitespace'?: boolean
  readonly children?: ReactNode
}

/**
 * 在终端中 bold 和 dim 是互斥的。
 * 此类型确保你只能使用其中之一，但不能同时使用。
 */
type WeightProps =
  | {
      bold?: never
      dim?: never
    }
  | {
      bold: boolean
      dim?: never
    }
  | {
      dim: boolean
      bold?: never
    }
export type Props = BaseProps & WeightProps
const memoizedStylesForWrap: Record<NonNullable<Styles['textWrap']>, Styles> = {
  wrap: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'wrap',
  },
  'wrap-trim': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'wrap-trim',
  },
  end: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'end',
  },
  middle: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'middle',
  },
  'truncate-end': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-end',
  },
  truncate: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate',
  },
  'truncate-middle': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-middle',
  },
  'truncate-start': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-start',
  },
} as const

/**
 * 此组件用于显示文本，并可更改样式使其多彩色、加粗、下划线、斜体或删除线。
 */
export default function Text({
  color,
  backgroundColor,
  bold,
  dim,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  'aria-preserve-whitespace': preserveWhitespace,
  children,
}: Props) {
  if (children === undefined || children === null) {
    return null
  }
  const textStyles = {
    ...(color && {
      color,
    }),
    ...(backgroundColor && {
      backgroundColor,
    }),
    ...(dim && {
      dim,
    }),
    ...(bold && {
      bold,
    }),
    ...(italic && {
      italic,
    }),
    ...(underline && {
      underline,
    }),
    ...(strikethrough && {
      strikethrough,
    }),
    ...(inverse && {
      inverse,
    }),
  }
  const textNode = React.createElement(
    'ink-text' as React.ElementType,
    {
      style: memoizedStylesForWrap[wrap],
      textStyles,
      'aria-preserve-whitespace': preserveWhitespace,
    },
    children,
  )
  return textNode
}
