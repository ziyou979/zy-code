import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'

/**
 * 为用户消息标记 sourceToolUseID，使其在 Tool 执行完成前保持临时状态。
 * 这可避免 UI 中重复显示“正在运行”消息。
 */
export function tagMessagesWithToolUseID(
  messages: (UserMessage | AttachmentMessage | SystemMessage)[],
  toolUseID: string | undefined,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  if (!toolUseID) {
    return messages
  }
  return messages.map((m) => {
    if (m.type === 'user') {
      return { ...m, sourceToolUseID: toolUseID }
    }
    return m
  })
}

/**
 * 从父消息中提取指定 Tool 名称对应的 tool use ID。
 */
export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  const content = parentMessage.message.content
  const toolUseBlock = content.find(
    (block) => block.type === 'tool_call' && block.name === toolName,
  )
  return toolUseBlock && toolUseBlock.type === 'tool_call' ? toolUseBlock.id : undefined
}
