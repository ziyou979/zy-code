import figures from 'figures'
import * as React from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import type { ContextSuggestion } from '../utils/contextSuggestions.js'
import { formatTokens } from '../utils/format.js'
import { StatusIcon } from './design-system/StatusIcon.js'
type Props = {
  suggestions: ContextSuggestion[]
}
export function ContextSuggestions({ suggestions }: Props) {
  if (suggestions.length === 0) {
    return null
  }
  const suggestionElements = suggestions.map((suggestion, i) => (
    <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
      <Box>
        <StatusIcon status={suggestion.severity} withSpace={true} />
        <Text bold={true}>{suggestion.title}</Text>
        {suggestion.savingsTokens ? (
          <Text dimColor={true}>
            {' '}
            {figures.arrowRight}{' '}
            {tSync('contextSuggestions.save', { tokens: formatTokens(suggestion.savingsTokens) })}
          </Text>
        ) : null}
      </Box>
      <Box marginLeft={2}>
        <Text dimColor={true}>{suggestion.detail}</Text>
      </Box>
    </Box>
  ))
  return (
    <Box flexDirection="column" marginTop={1}>
      {<Text bold={true}>{tSync('contextSuggestions.title')}</Text>}
      {suggestionElements}
    </Box>
  )
}
