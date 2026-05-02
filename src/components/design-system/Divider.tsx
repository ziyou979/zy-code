import React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Ansi, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
type DividerProps = {
  /**
   * Width of the divider in characters.
   * Defaults to terminal width.
   */
  width?: number

  /**
   * Theme color for the divider.
   * If not provided, dimColor is used.
   */
  color?: keyof Theme

  /**
   * Character to use for the divider line.
   * @default '─'
   */
  char?: string

  /**
   * Padding to subtract from the width (e.g., for indentation).
   * @default 0
   */
  padding?: number

  /**
   * Title shown in the middle of the divider.
   * May contain ANSI codes (e.g., chalk-styled text).
   *
   * @example
   * // ─────────── Title ───────────
   * <Divider title="Title" />
   */
  title?: string
}

/**
 * A horizontal divider line.
 *
 * @example
 * // Full-width dimmed divider
 * <Divider />
 *
 * @example
 * // Colored divider
 * <Divider color="suggestion" />
 *
 * @example
 * // Fixed width
 * <Divider width={40} />
 *
 * @example
 * // Full width minus padding (for indented content)
 * <Divider padding={4} />
 *
 * @example
 * // With centered title
 * <Divider title="3 new messages" />
 */
export function Divider({ width, color, char = '\u2500', padding = 0, title }: DividerProps) {
  const { columns: terminalWidth } = useTerminalSize()
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding)
  if (title) {
    const titleWidth = stringWidth(title) + 2
    const sideWidth = Math.max(0, effectiveWidth - titleWidth)
    const leftWidth = Math.floor(sideWidth / 2)
    const rightWidth = sideWidth - leftWidth
    const t4 = char.repeat(leftWidth)
    const t6 = char.repeat(rightWidth)
    return (
      <Text color={color} dimColor={!color}>
        {t4}{' '}
        {
          <Text dimColor={true}>
            <Ansi>{title}</Ansi>
          </Text>
        }{' '}
        {t6}
      </Text>
    )
  }
  const t4 = char.repeat(effectiveWidth)
  return (
    <Text color={color} dimColor={!color}>
      {t4}
    </Text>
  )
}
