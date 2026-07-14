import type React from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useTheme } from '../../../ink.js'
import { filterToolProgressMessages, type Tool, type Tools } from '../../../tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import type { buildMessageLookups } from '../../../services/messages/index.js'
import { FallbackToolUseRejectedMessage } from '../../FallbackToolUseRejectedMessage.js'

type Props = {
  input: {
    [key: string]: unknown
  }
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tool?: Tool
  tools: Tools
  lookups: ReturnType<typeof buildMessageLookups>
  verbose: boolean
  isTranscriptMode?: boolean
}
export function UserToolRejectMessage({
  input,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  isTranscriptMode,
}: Props) {
  const { columns } = useTerminalSize()
  const [theme] = useTheme()
  if (!tool?.renderToolUseRejectedMessage) {
    return <FallbackToolUseRejectedMessage />
  }
  let fallbackToolUseRejectedMessageElement
  let earlyReturn: React.ReactNode | symbol
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const parsedInput = tool.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    earlyReturn = <FallbackToolUseRejectedMessage />
  } else {
    fallbackToolUseRejectedMessageElement = tool.renderToolUseRejectedMessage(parsedInput.data, {
      columns,
      messages: [],
      tools,
      verbose,
      progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
      style,
      theme,
      isTranscriptMode,
    }) ?? <FallbackToolUseRejectedMessage />
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as React.ReactNode
  }
  return fallbackToolUseRejectedMessageElement
}
