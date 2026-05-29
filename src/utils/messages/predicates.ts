import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { COMMAND_ARGS_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ContentBlock, ToolCallBlock, ToolResultBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemLocalCommandMessage,
  UserMessage,
} from '../../types/message.js'
import type { DeepImmutable } from '../../types/utils.js'
import { stripIdeContextTags } from '../displayTags.js'
import { escapeRegExp } from '../stringUtils.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from './constants.js'

const MEMORY_CORRECTION_HINT =
  "\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."

export function withMemoryCorrectionHint(message: string): string {
  if (isAutoMemoryEnabled() && getFeatureValue_CACHED_MAY_BE_STALE('zy_amber_prism', false)) {
    return message + MEMORY_CORRECTION_HINT
  }
  return message
}

export function deriveShortMessageId(uuid: string): string {
  const hex = uuid.replace(/-/g, '').slice(0, 10)
  return parseInt(hex, 16).toString(36).slice(0, 6)
}

export function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  return messages.findLast((msg): msg is AssistantMessage => msg.type === 'assistant')
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        return content.some((block) => block.type === 'tool_call')
      }
    }
  }
  return false
}

export function extractTag(html: string, tagName: string): string | null {
  if (!html.trim() || !tagName.trim()) {
    return null
  }

  const escapedTag = escapeRegExp(tagName)

  const pattern = new RegExp(`<${escapedTag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'gi')

  let match: RegExpExecArray | null
  let depth = 0
  let lastIndex = 0
  const openingTag = new RegExp(`<${escapedTag}(?:\\s+[^>]*?)?>`, 'gi')
  const closingTag = new RegExp(`<\\/${escapedTag}>`, 'gi')

  while ((match = pattern.exec(html)) !== null) {
    const content = match[1]
    const beforeMatch = html.slice(lastIndex, match.index)
    depth = 0
    openingTag.lastIndex = 0
    while (openingTag.exec(beforeMatch) !== null) {
      depth++
    }
    closingTag.lastIndex = 0
    while (closingTag.exec(beforeMatch) !== null) {
      depth--
    }
    if (depth === 0 && content) {
      return content
    }
    lastIndex = match.index + match[0].length
  }

  return null
}

export function isNotEmptyMessage(message: Message): boolean {
  if (!message) {
    return false
  }
  if (
    message.type === 'progress' ||
    message.type === 'attachment' ||
    message.type === 'system' ||
    message.type === 'tool_use_summary' ||
    message.type === 'stream_event' ||
    message.type === 'stream_request_start'
  ) {
    return true
  }

  const msg = message as UserMessage | AssistantMessage

  if (msg.message.content.length === 0) {
    return false
  }

  if (msg.message.content.length > 1) {
    return true
  }

  if (msg.message.content[0]!.type !== 'text') {
    return true
  }

  return (
    msg.message.content[0]!.text.trim().length > 0 &&
    msg.message.content[0]!.text !== NO_CONTENT_MESSAGE &&
    msg.message.content[0]!.text !== INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

// 确定性 UUID 派生。从父 UUID + 内容块索引生成稳定的 UUID 形状字符串，
// 使相同输入始终在跨调用时产生相同的 key。
export function deriveUUID(parentUUID: string, index: number): UUID {
  const hex = index.toString(16).padStart(12, '0')
  return `${parentUUID.slice(0, 24)}${hex}` as UUID
}

export type ToolUseRequestMessage = AssistantMessage & {
  message: { content: [ToolCallBlock] }
}

export function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    Array.isArray(message.message.content) &&
    message.message.content.some((_) => _.type === 'tool_call')
  )
}

export type ToolUseResultMessage = UserMessage & {
  message: { content: [ToolResultBlock] }
}

export function isToolUseResultMessage(message: Message): message is ToolUseResultMessage {
  return (
    message.type === 'user' &&
    ((Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'tool_result') ||
      Boolean(message.toolUseResult))
  )
}

export function isSystemLocalCommandMessage(
  message: Message,
): message is SystemLocalCommandMessage {
  return message.type === 'system' && message.subtype === 'local_command'
}

export function isHookAttachmentMessage(
  message: Message,
): message is AttachmentMessage<Record<string, unknown>> {
  return (
    message.type === 'attachment' &&
    (message.attachment.type === 'hook_blocking_error' ||
      message.attachment.type === 'hook_cancelled' ||
      message.attachment.type === 'hook_error_during_execution' ||
      message.attachment.type === 'hook_non_blocking_error' ||
      message.attachment.type === 'hook_success' ||
      message.attachment.type === 'hook_system_message' ||
      message.attachment.type === 'hook_additional_context' ||
      message.attachment.type === 'hook_stopped_continuation')
  )
}

const STRIPPED_TAGS_RE = /<(commit_analysis|context|function_analysis|pr_analysis)>.*?<\/\1>\n?/gs

export function stripPromptXMLTags(content: string): string {
  return content.replace(STRIPPED_TAGS_RE, '').trim()
}

export function isEmptyMessageText(text: string): boolean {
  return stripPromptXMLTags(text).trim() === '' || text.trim() === NO_CONTENT_MESSAGE
}

export function getToolUseID(message: Message): string | null {
  switch (message.type) {
    case 'attachment':
      if (isHookAttachmentMessage(message)) {
        return (message.attachment as Record<string, unknown>).toolUseID as string | null
      }
      return null
    case 'assistant':
      if (message.message.content[0]?.type !== 'tool_call') {
        return null
      }
      return message.message.content[0].id
    case 'user':
      if (message.sourceToolUseID) {
        return message.sourceToolUseID
      }

      if (message.message.content[0]?.type !== 'tool_result') {
        return null
      }
      return message.message.content[0].toolCallId
    case 'progress':
      return message.toolUseID
    case 'system':
      return message.subtype === 'informational' ? (message.toolUseID ?? null) : null
  }
}

export function getAssistantMessageText(message: Message): string | null {
  if (message.type !== 'assistant') {
    return null
  }

  if (Array.isArray(message.message.content)) {
    return (
      message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim() || null
    )
  }
  return null
}

export function getUserMessageText(message: Message): string | null {
  if (message.type !== 'user') {
    return null
  }

  const content = message.message.content

  return getContentText(content)
}

export function textForResubmit(
  msg: UserMessage,
): { text: string; mode: 'bash' | 'prompt' } | null {
  const content = getUserMessageText(msg)
  if (content === null) {
    return null
  }
  const bash = extractTag(content, 'bash-input')
  if (bash) {
    return { text: bash, mode: 'bash' }
  }
  const cmd = extractTag(content, COMMAND_NAME_TAG)
  if (cmd) {
    const args = extractTag(content, COMMAND_ARGS_TAG) ?? ''
    return { text: `${cmd} ${args}`, mode: 'prompt' }
  }
  return { text: stripIdeContextTags(content), mode: 'prompt' }
}

/**
 * 从内容块数组中提取文本，用给定分隔符连接文本块。
 * 通过结构化类型兼容 ContentBlock 及其 readonly/DeepImmutable 变体。
 */
export function extractTextContent(
  blocks: readonly { readonly type: string }[],
  separator = '',
): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(separator)
}

export function getContentText(
  content: string | DeepImmutable<Array<ContentBlock>>,
): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return extractTextContent(content, '\n').trim() || null
  }
  return null
}

export function isCompactBoundaryMessage(
  message: Message,
): message is SystemCompactBoundaryMessage {
  return message?.type === 'system' && message.subtype === 'compact_boundary'
}

export function findLastCompactBoundaryIndex<T extends Message>(
  messages: T[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isCompactBoundaryMessage(message)) {
      return i
    }
  }
  return -1
}

/**
 * 返回从最后一个 compact 边界开始（包含边界本身）的消息。
 * 不存在边界时返回所有消息。
 */
export function getMessagesAfterCompactBoundary<T extends Message>(
  messages: T[],
): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  return boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)
}

export function shouldShowUserMessage(
  message: Message,
  isTranscriptMode: boolean,
): boolean {
  if (message.type !== 'user') {
    return true
  }
  if (message.isMeta) {
    // Channel 消息保持 isMeta（用于 snip-tag/turn-boundary/brief-mode 语义），
    // 但在默认 transcript 中渲染 — 键盘用户应该看到到达的内容。
    if ((feature('KAIROS') || feature('KAIROS_CHANNELS')) && message.origin?.kind === 'channel') {
      return true
    }
    return false
  }
  if (message.isVisibleInTranscriptOnly && !isTranscriptMode) {
    return false
  }
  return true
}

export function isThinkingMessage(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  if (!Array.isArray(message.message.content)) {
    return false
  }
  return message.message.content.every(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

/**
 * 统计消息历史中对指定工具的总调用次数。达到 maxCount 时提前终止。
 */
export function countToolCalls(messages: Message[], toolName: string, maxCount?: number): number {
  let count = 0
  for (const msg of messages) {
    if (!msg) {
      continue
    }
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const hasToolUse = msg.message.content.some(
        (block): block is ToolCallBlock => block.type === 'tool_call' && block.name === toolName,
      )
      if (hasToolUse) {
        count++
        if (maxCount && count >= maxCount) {
          return count
        }
      }
    }
  }
  return count
}

/**
 * 检查最近一次工具调用是否成功（有 result 且无 is_error）。反向搜索。
 */
export function hasSuccessfulToolCall(messages: Message[], toolName: string): boolean {
  let mostRecentToolUseId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      continue
    }
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const toolUse = msg.message.content.find(
        (block): block is ToolCallBlock => block.type === 'tool_call' && block.name === toolName,
      )
      if (toolUse) {
        mostRecentToolUseId = toolUse.id
        break
      }
    }
  }

  if (!mostRecentToolUseId) {
    return false
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      continue
    }
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const toolResult = msg.message.content.find(
        (block): block is ToolResultBlock =>
          block.type === 'tool_result' && block.toolCallId === mostRecentToolUseId,
      )
      if (toolResult) {
        return toolResult.isError !== true
      }
    }
  }

  return false
}
