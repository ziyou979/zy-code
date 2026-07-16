import type { Tools } from '../../../tools/Tool.js'
import type { ToolResultBlock } from '../../../types/llm.js'
import type { ProgressMessage, UserMessage } from '../../../types/message.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
} from '../../../services/messages/./constants.js'
import type { buildMessageLookups } from '../../../services/messages/./lookups.js'
import { UserToolCanceledMessage } from './UserToolCanceledMessage.js'
import { UserToolErrorMessage } from './UserToolErrorMessage.js'
import { UserToolRejectMessage } from './UserToolRejectMessage.js'
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js'
import { useGetToolFromMessages } from './utils.js'

type Props = {
  param: ToolResultBlock
  message: UserMessage
  lookups: ReturnType<typeof buildMessageLookups>
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tools: Tools
  verbose: boolean
  width: number | string
  isTranscriptMode?: boolean
}
export function UserToolResultMessage({
  param,
  message,
  lookups,
  progressMessagesForMessage,
  style,
  tools,
  verbose,
  width,
  isTranscriptMode,
}: Props) {
  const toolUse = useGetToolFromMessages(param.toolCallId, tools, lookups as unknown as Parameters<typeof useGetToolFromMessages>[2])
  if (!toolUse) {
    return null
  }
  if (typeof param.content === 'string' && param.content.startsWith(CANCEL_MESSAGE)) {
    return <UserToolCanceledMessage />
  }
  if (
    (typeof param.content === 'string' && param.content.startsWith(REJECT_MESSAGE)) ||
    param.content === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    const toolInput = toolUse.toolUse.input as {
      [key: string]: unknown
    }
    return (
      <UserToolRejectMessage
        input={toolInput}
        progressMessagesForMessage={progressMessagesForMessage}
        tool={toolUse.tool}
        tools={tools}
        lookups={lookups}
        style={style}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }
  if (param.isError) {
    return (
      <UserToolErrorMessage
        progressMessagesForMessage={progressMessagesForMessage}
        tool={toolUse.tool}
        tools={tools}
        param={param}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }
  return (
    <UserToolSuccessMessage
      message={message}
      lookups={lookups}
      toolUseID={toolUse.toolUse.id}
      progressMessagesForMessage={progressMessagesForMessage}
      style={style}
      tool={toolUse.tool}
      tools={tools}
      verbose={verbose}
      width={width}
      isTranscriptMode={isTranscriptMode}
    />
  )
}
