import { memo } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { truncatePathMiddle, truncateToWidth } from '../../utils/format.js'
import type { Theme } from '../../utils/theme.js'
export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
  matchedAlias?: string
}
export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'
export const OVERLAY_MAX_ITEMS = 5

/**
 * Get the icon for a suggestion based on its type
 * Icons: + for files, ◇ for MCP resources, * for agents
 */
function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) {
    return '+'
  }
  if (itemId.startsWith('mcp-resource-')) {
    return '◇'
  }
  if (itemId.startsWith('agent-')) {
    return '*'
  }
  return '+'
}

/**
 * Check if an item is a unified suggestion type (file, mcp-resource, or agent)
 */
function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith('file-') || itemId.startsWith('mcp-resource-') || itemId.startsWith('agent-')
  )
}
const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
}: {
  item: SuggestionItem
  maxColumnWidth: number
  isSelected: boolean
}) {
  const columns = useTerminalSize().columns
  const isUnified = isUnifiedSuggestion(item.id)
  if (isUnified) {
    const icon = getIcon(item.id)
    const textColor = isSelected ? 'suggestion' : undefined
    const dimColor = !isSelected
    const isFile = item.id.startsWith('file-')
    const isMcpResource = item.id.startsWith('mcp-resource-')
    const separatorWidth = item.description ? 3 : 0
    let displayText
    if (isFile) {
      const descReserve = item.description ? Math.min(20, stringWidth(item.description)) : 0
      const maxPathLength = columns - 2 - 4 - separatorWidth - descReserve
      displayText = truncatePathMiddle(item.displayText, maxPathLength)
    } else {
      if (isMcpResource) {
        displayText = truncateToWidth(item.displayText, 30)
      } else {
        displayText = item.displayText
      }
    }
    const availableWidth = columns - 2 - stringWidth(displayText) - separatorWidth - 4
    let lineContent
    if (item.description) {
      const maxDescLength = Math.max(0, availableWidth)
      const truncatedDesc = truncateToWidth(item.description.replace(/\s+/g, ' '), maxDescLength)
      lineContent = `${icon} ${displayText} – ${truncatedDesc}`
    } else {
      lineContent = `${icon} ${displayText}`
    }
    return (
      <Text color={textColor} dimColor={dimColor} wrap="truncate">
        {lineContent}
      </Text>
    )
  }
  const maxNameWidth = Math.floor(columns * 0.4)
  const displayTextWidth = Math.min(
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
    maxNameWidth,
  )
  const textColor_0 = item.color || (isSelected ? 'suggestion' : undefined)
  const shouldDim = !isSelected
  let displayText_0 = item.displayText
  if (stringWidth(displayText_0) > displayTextWidth - 2) {
    displayText_0 = truncateToWidth(displayText_0, displayTextWidth - 2)
  }
  const paddedDisplayText =
    displayText_0 + ' '.repeat(Math.max(0, displayTextWidth - stringWidth(displayText_0)))
  const tagText = item.tag ? `[${item.tag}] ` : ''
  const tagWidth = stringWidth(tagText)
  const descriptionWidth = Math.max(0, columns - displayTextWidth - tagWidth - 4)
  const truncatedDescription = item.description
    ? truncateToWidth(item.description.replace(/\s+/g, ' '), descriptionWidth)
    : ''
  return (
    <Text wrap="truncate">
      {
        <Text color={textColor_0} dimColor={shouldDim}>
          {paddedDisplayText}
        </Text>
      }
      {tagText ? <Text dimColor={true}>{tagText}</Text> : null}
      {
        <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
          {truncatedDescription}
        </Text>
      }
    </Text>
  )
})
type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  /**
   * When true, the suggestions are rendered inside a position=absolute
   * overlay. We omit minHeight and flex-end so the y-clamp in the
   * renderer doesn't push fewer items down into the prompt area.
   */
  overlay?: boolean
}
export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props) {
  const { rows } = useTerminalSize()
  const maxVisibleItems = overlay ? OVERLAY_MAX_ITEMS : Math.min(6, Math.max(1, rows - 3))
  if (suggestions.length === 0) {
    return null
  }
  const maxColumnWidth =
    maxColumnWidthProp ?? Math.max(...suggestions.map((item) => stringWidth(item.displayText))) + 5
  const startIndex = Math.max(
    0,
    Math.min(
      selectedSuggestion - Math.floor(maxVisibleItems / 2),
      suggestions.length - maxVisibleItems,
    ),
  )
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length)
  const visibleItems = suggestions.slice(startIndex, endIndex)
  const renderedItems = visibleItems.map((item_0) => (
    <SuggestionItemRow
      key={item_0.id}
      item={item_0}
      maxColumnWidth={maxColumnWidth}
      isSelected={item_0.id === suggestions[selectedSuggestion]?.id}
    />
  ))
  return (
    <Box flexDirection={'column'} justifyContent={overlay ? undefined : 'flex-end'}>
      {renderedItems}
    </Box>
  )
}
export default memo(PromptInputFooterSuggestions)
