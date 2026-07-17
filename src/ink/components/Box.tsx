import '../global.d.ts'
import React, { type Ref } from 'react'

import type { Except } from 'type-fest'
import type { DOMElement } from '../dom.js'
import type { ClickEvent } from '../events/clickEvent.js'
import type { FocusEvent } from '../events/focusEvent.js'
import type { KeyboardEvent } from '../events/keyboardEvent.js'
import type { Styles } from '../styles.js'
import * as warn from '../warn.js'
export type Props = Except<Styles, 'textWrap'> & {
  children?: React.ReactNode
  ref?: Ref<DOMElement>
  /**
   * Tab 顺序索引。`tabIndex >= 0` 的节点参与 Tab/Shift+Tab 循环；
   * `-1` 表示仅可编程聚焦。
   */
  tabIndex?: number
  /**
   * 元素挂载时自动聚焦。类似 HTML `autofocus` 属性——FocusManager
   * 在 reconciler 的 `commitMount` 阶段调用 `focus(node)`。
   */
  autoFocus?: boolean
  /**
   * 左键点击时触发（按下 + 释放，无拖拽）。仅在启用鼠标追踪的
   * `<AlternateScreen>` 内有效——否则无作用。事件从最深的命中 Box
   * 向上冒泡到祖先；调用 `event.stopImmediatePropagation()` 可阻止冒泡。
   */
  onClick?: (event: ClickEvent) => void
  onFocus?: (event: FocusEvent) => void
  onFocusCapture?: (event: FocusEvent) => void
  onBlur?: (event: FocusEvent) => void
  onBlurCapture?: (event: FocusEvent) => void
  onKeyDown?: (event: KeyboardEvent) => void
  onKeyDownCapture?: (event: KeyboardEvent) => void
  /**
   * 鼠标移入此 Box 的渲染区域时触发。类似 DOM `mouseenter`，
   * 不会冒泡——在子元素之间移动不会在父元素上重新触发。
   * 仅在启用 mode-1003 鼠标追踪的 `<AlternateScreen>` 内有效。
   */
  onMouseEnter?: () => void
  /** 鼠标移出此 Box 的渲染区域时触发。 */
  onMouseLeave?: () => void
}

/**
 * `<Box>` 是构建布局的核心 Ink 组件。类似于浏览器中的 `<div style="display: flex">`。
 */
function Box({
  children,
  flexWrap = 'nowrap',
  flexDirection = 'row',
  flexGrow = 0,
  flexShrink = 1,
  ref,
  tabIndex,
  autoFocus,
  onClick,
  onFocus,
  onFocusCapture,
  onBlur,
  onBlurCapture,
  onMouseEnter,
  onMouseLeave,
  onKeyDown,
  onKeyDownCapture,
  ...style
}: Props) {
  warn.ifNotInteger(style.margin, 'margin')
  warn.ifNotInteger(style.marginX, 'marginX')
  warn.ifNotInteger(style.marginY, 'marginY')
  warn.ifNotInteger(style.marginTop, 'marginTop')
  warn.ifNotInteger(style.marginBottom, 'marginBottom')
  warn.ifNotInteger(style.marginLeft, 'marginLeft')
  warn.ifNotInteger(style.marginRight, 'marginRight')
  warn.ifNotInteger(style.padding, 'padding')
  warn.ifNotInteger(style.paddingX, 'paddingX')
  warn.ifNotInteger(style.paddingY, 'paddingY')
  warn.ifNotInteger(style.paddingTop, 'paddingTop')
  warn.ifNotInteger(style.paddingBottom, 'paddingBottom')
  warn.ifNotInteger(style.paddingLeft, 'paddingLeft')
  warn.ifNotInteger(style.paddingRight, 'paddingRight')
  warn.ifNotInteger(style.gap, 'gap')
  warn.ifNotInteger(style.columnGap, 'columnGap')
  warn.ifNotInteger(style.rowGap, 'rowGap')
  const InkBox = 'ink-box' as React.ElementType
  return (
    <InkBox
      ref={ref}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      onClick={onClick}
      onFocus={onFocus}
      onFocusCapture={onFocusCapture}
      onBlur={onBlur}
      onBlurCapture={onBlurCapture}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
      style={{
        flexWrap,
        flexDirection,
        flexGrow,
        flexShrink,
        ...style,
        overflowX: style.overflowX ?? style.overflow ?? 'visible',
        overflowY: style.overflowY ?? style.overflow ?? 'visible',
      }}
    >
      {children}
    </InkBox>
  )
}
export default Box
