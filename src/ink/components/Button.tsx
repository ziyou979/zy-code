import React, { type Ref, useEffect, useRef, useState } from 'react'
import type { Except } from 'type-fest'
import type { DOMElement } from '../dom.js'
import type { Styles } from '../styles.js'
import Box from './Box.js'
type ButtonState = {
  focused: boolean
  hovered: boolean
  active: boolean
}
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>
  /**
   * 通过 Enter、Space 或点击激活按钮时调用。
   */
  onAction: () => void
  /**
   * Tab 顺序索引。默认为 0（在 tab 顺序中）。
   * 设为 -1 表示仅可编程聚焦。
   */
  tabIndex?: number
  /**
   * 按钮挂载时自动聚焦。
   */
  autoFocus?: boolean
  /**
   * 渲染 prop，接收交互状态。用于根据 focus/hover/active 状态
   * 设置子元素样式——Button 本身有意不添加样式。
   *
   * 如果不提供，子元素将原样渲染（无状态依赖样式）。
   */
  children: ((state: ButtonState) => React.ReactNode) | React.ReactNode
}
function Button({ onAction, tabIndex = 0, autoFocus, children, ref, ...style }: Props) {
  const [isFocused, setIsFocused] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const activeTimer = useRef(null)
  useEffect(
    () => () => {
      if (activeTimer.current) {
        clearTimeout(activeTimer.current)
      }
    },
    [],
  )
  const handleKeyDown = (e) => {
    if (e.key === 'return' || e.key === ' ') {
      e.preventDefault()
      setIsActive(true)
      onAction()
      if (activeTimer.current) {
        clearTimeout(activeTimer.current)
      }
      activeTimer.current = setTimeout((setter) => setter(false), 100, setIsActive)
    }
  }
  const handleClick = (_e) => {
    onAction()
  }
  const handleFocus = (_event) => setIsFocused(true)
  const handleBlur = (_event) => setIsFocused(false)
  const handleMouseEnter = () => setIsHovered(true)
  const handleMouseLeave = () => setIsHovered(false)
  const state = {
    focused: isFocused,
    hovered: isHovered,
    active: isActive,
  }
  const content = typeof children === 'function' ? children(state) : children
  return (
    <Box
      ref={ref}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...style}
    >
      {content}
    </Box>
  )
}
export default Button
export type { ButtonState }
