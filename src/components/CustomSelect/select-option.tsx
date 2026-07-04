import { type ReactNode } from 'react'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { ListItem } from '../design-system/ListItem.js'
export type SelectOptionProps = {
  /**
   * Determines if option is focused.
   */
  readonly isFocused: boolean

  /**
   * Determines if option is selected.
   */
  readonly isSelected: boolean

  /**
   * Option label.
   */
  readonly children: ReactNode

  /**
   * Optional description to display below the label.
   */
  readonly description?: string

  /**
   * Determines if the down arrow should be shown.
   */
  readonly shouldShowDownArrow?: boolean

  /**
   * Determines if the up arrow should be shown.
   */
  readonly shouldShowUpArrow?: boolean

  /**
   * Whether ListItem should declare the terminal cursor position.
   * Set false when a child declares its own cursor (e.g. BaseTextInput).
   */
  readonly declareCursor?: boolean

  /**
   * 鼠标悬浮态。仅影响 indicator，不影响文字颜色和 ✓。
   * @default false
   */
  readonly isHovered?: boolean

  /**
   * 鼠标点击时触发。仅在启用鼠标追踪的 AlternateScreen 内有效。
   */
  readonly onClick?: (event: ClickEvent) => void

  /**
   * 鼠标移入选项时触发。用于同步键盘焦点和悬浮高亮。
   */
  readonly onMouseEnter?: () => void

  /**
   * 鼠标移出选项时触发。用于清除悬浮高亮。
   */
  readonly onMouseLeave?: () => void
}
export function SelectOption({
  isFocused,
  isSelected,
  isHovered = false,
  children,
  description,
  shouldShowDownArrow,
  shouldShowUpArrow,
  declareCursor,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: SelectOptionProps) {
  return (
    <ListItem
      isFocused={isFocused}
      isSelected={isSelected}
      isHovered={isHovered}
      description={description}
      showScrollDown={shouldShowDownArrow}
      showScrollUp={shouldShowUpArrow}
      styled={false}
      declareCursor={declareCursor}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </ListItem>
  )
}
