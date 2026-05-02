import React from 'react'
import { Box, Text } from '../../ink.js'

/**
 * Renders a visual boundary marker for snipped (compacted) conversation history.
 */
export function SnipBoundaryMessage({ message: _message }: { message: { type: string } }) {
  return (
    <Box>
      <Text dimColor>--- conversation history snipped ---</Text>
    </Box>
  )
}
