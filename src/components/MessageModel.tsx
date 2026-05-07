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
  const content = Array.isArray(message.message.content) ? message.message.content : []
  const shouldShowModel =
    isTranscriptMode &&
    message.message.model &&
    content.some((c) => typeof c !== 'string' && c.type === 'text')
  if (!shouldShowModel) {
    return null
  }
  const t1 = stringWidth(message.message.model as string) + 8
  return <Box minWidth={t1}>{<Text dimColor={true}>{message.message.model as string}</Text>}</Box>
}
