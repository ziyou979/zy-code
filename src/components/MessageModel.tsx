import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink/index.js'
import type { Message } from '../types/message.js'

type Props = {
  message: Message
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
