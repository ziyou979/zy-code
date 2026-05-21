import React, { Children, isValidElement } from 'react'
import { Text } from '../../ink.js'

type Props = {
  /** The items to join with a middot separator */
  children: React.ReactNode
}

/**
 * Joins children with a middot separator (" · ") for inline metadata display.
 *
 * Named after the publishing term "byline" - the line of metadata typically
 * shown below a title (e.g., "John Doe · 5 min read · Mar 12").
 *
 * Automatically filters out null/undefined/false children and only renders
 * separators between valid elements.
 *
 * @example
 * // Basic usage: "Enter to confirm · Esc to cancel"
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 * @example
 * // With conditional children: "Esc to cancel" (only one item shown)
 * <Text dimColor>
 *   <Byline>
 *     {showEnter && <KeyboardShortcutHint shortcut="Enter" action="confirm" />}
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 */
export function Byline({ children }: Props) {
  let mappedItems
  let earlyReturn
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const validChildren = Children.toArray(children)
  if (validChildren.length === 0) {
    earlyReturn = null
  } else {
    mappedItems = validChildren.map((child, index) => (
      <React.Fragment key={isValidElement(child) ? (child.key ?? index) : index}>
        {index > 0 && <Text dimColor={true}> · </Text>}
        {child}
      </React.Fragment>
    ))
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn
  }
  return <>{mappedItems}</>
}
