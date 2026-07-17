import type { ReactNode } from 'react'
import { ARROW_DOWN, ARROW_UP, POINTER, TICK } from '../../constants/figures.js'
import type { ClickEvent } from '../../ink/events/clickEvent.js'
import { useDeclaredCursor } from '../../ink/hooks/useDeclaredCursor.js'
import { Box, Text } from '../../ink/index.js'

type ListItemProps = {
  /**
   * Whether this item is currently focused (keyboard selection).
   * Shows the pointer indicator (❯) when true.
   */
  isFocused: boolean

  /**
   * Whether this item is selected (chosen/checked).
   * Shows the checkmark indicator (✓) when true.
   * @default false
   */
  isSelected?: boolean

  /**
   * The content to display for this item.
   */
  children: ReactNode

  /**
   * Optional description text displayed below the main content.
   */
  description?: string

  /**
   * Show a down arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollDown?: boolean

  /**
   * Show an up arrow indicator instead of pointer (for scroll hints).
   * Only applies when not focused.
   */
  showScrollUp?: boolean

  /**
   * Whether to apply automatic styling to the children based on focus/selection state.
   * - When true (default): children are wrapped in Text with state-based colors
   * - When false: children are rendered as-is, allowing custom styling
   * @default true
   */
  styled?: boolean

  /**
   * Whether this item is disabled. Disabled items show dimmed text and no indicators.
   * @default false
   */
  disabled?: boolean

  /**
   * Whether this ListItem should declare the terminal cursor position.
   * Set false when a child (e.g. BaseTextInput) declares its own cursor.
   * @default true
   */
  declareCursor?: boolean

  /**
   * 鼠标悬浮态。由父组件根据 hoveredId 计算传入。
   * hover 只在非 focused/selected/disabled 时显示 dim `>` 指示器，
   * 不会改变文字颜色或显示 ✓，避免与真实选中态混淆。
   * @default false
   */
  isHovered?: boolean

  /**
   * 鼠标点击时触发。仅在启用鼠标追踪的 AlternateScreen 内有效。
   */
  onClick?: (event: ClickEvent) => void

  /**
   * 鼠标移入时触发。用于列表项 hover/focus 联动。
   */
  onMouseEnter?: () => void

  /**
   * 鼠标移出时触发。用于清除悬浮高亮。
   */
  onMouseLeave?: () => void
}

/**
 * A list item component for selection UIs (dropdowns, multi-selects, menus).
 *
 * Handles the common pattern of:
 * - Pointer indicator (❯) for focused items
 * - Checkmark indicator (✓) for selected items
 * - Scroll indicators (↓↑) for truncated lists
 * - Color states for focus/selection
 *
 * @example
 * // Basic usage in a selection list
 * {options.map((option, i) => (
 *   <ListItem
 *     key={option.id}
 *     isFocused={focusIndex === i}
 *     isSelected={selectedId === option.id}
 *   >
 *     {option.label}
 *   </ListItem>
 * ))}
 *
 * @example
 * // With scroll indicators
 * <ListItem isFocused={false} showScrollUp>First visible item</ListItem>
 * ...
 * <ListItem isFocused={false} showScrollDown>Last visible item</ListItem>
 *
 * @example
 * // With description
 * <ListItem isFocused isSelected={false} description="Secondary text here">
 *   Primary text
 * </ListItem>
 *
 * @example
 * // Custom children styling (styled=false)
 * <ListItem isFocused styled={false}>
 *   <Text color="zy">Custom styled content</Text>
 * </ListItem>
 */
export function ListItem({
  isFocused,
  isSelected = false,
  isHovered = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: ListItemProps) {
  const renderIndicator = function renderIndicator() {
    if (disabled) {
      return <Text> </Text>
    }
    if (isFocused) {
      return <Text color="suggestion">{POINTER}</Text>
    }
    if (showScrollDown) {
      return <Text dimColor={true}>{ARROW_DOWN}</Text>
    }
    if (showScrollUp) {
      return <Text dimColor={true}>{ARROW_UP}</Text>
    }
    if (isHovered) {
      return <Text dimColor={true}>{POINTER}</Text>
    }
    return <Text> </Text>
  }
  const getTextColor = function getTextColor() {
    if (disabled) {
      return 'inactive'
    }
    if (!styled) {
      return
    }
    if (isSelected) {
      return 'success'
    }
    if (isFocused) {
      return 'suggestion'
    }
  }
  const textColor = getTextColor()
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor !== false,
  })
  const indicatorElement = renderIndicator()
  return (
    <Box
      ref={cursorRef}
      flexDirection="column"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {
        <Box flexDirection="row" gap={1}>
          {indicatorElement}
          {styled ? (
            <Text color={textColor} dimColor={disabled}>
              {children}
            </Text>
          ) : (
            children
          )}
          {isSelected && !disabled && <Text color="success">{TICK}</Text>}
        </Box>
      }
      {description && (
        <Box paddingLeft={2}>
          <Text color="inactive">{description}</Text>
        </Box>
      )}
    </Box>
  )
}
