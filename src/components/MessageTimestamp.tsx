import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink/index.js'
import { formatTimeShort } from '../utils/dateUtils.js'
import type { Message } from '../types/message.js'

type Props = {
  message: Message
  isTranscriptMode: boolean
}
export function MessageTimestamp({ message, isTranscriptMode }: Props) {
  const shouldShowTimestamp =
    isTranscriptMode &&
    message.timestamp &&
    message.type === 'assistant' &&
    message.message.content.some((c) => c.type === 'text')
  if (!shouldShowTimestamp) {
    return null
  }
  const TimestampBox = Box
  const formattedTimestamp = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
  const timestampWidth = stringWidth(formattedTimestamp)
  return (
    <TimestampBox minWidth={timestampWidth}>
      {<Text dimColor={true}>{formattedTimestamp}</Text>}
    </TimestampBox>
  )
}
