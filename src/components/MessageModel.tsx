import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import type { NormalizedMessage } from '../types/message.js'
type Props = {
  message: NormalizedMessage
  isTranscriptMode: boolean
}
export function MessageModel({ message, isTranscriptMode }: Props) {
  if (message.type !== 'assistant') {
    return null
  }
  const shouldShowModel =
    isTranscriptMode &&
    message.message.model &&
    message.message.content.some((c) => c.type === 'text')
  if (!shouldShowModel) {
    return null
  }
  const modelNameWidth = stringWidth(message.message.model as string) + 8
  return (
    <Box minWidth={modelNameWidth}>
      {<Text dimColor={true}>{message.message.model as string}</Text>}
    </Box>
  )
}
