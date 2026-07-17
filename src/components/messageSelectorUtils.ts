import type { UUID } from 'node:crypto'
import type { DiffStats } from 'src/services/file-persistence/fileHistory.js'
import type { FileEditOutput } from 'src/tools/FileEditTool/types.js'
import type { Output as FileWriteToolOutput } from 'src/tools/FileWriteTool/FileWriteTool.js'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import { isSyntheticMessage } from '../services/messages/./constants.js'
import { isToolUseResultMessage } from '../services/messages/./predicates.js'
import type { ContentBlock, TextBlock } from '../types/llm.js'
import type { Message, UserMessage } from '../types/message.js'
import { count } from '../utils/array.js'

export type RestoreOption =
  | 'both'
  | 'conversation'
  | 'code'
  | 'summarize'
  | 'summarize_up_to'
  | 'nevermind'

export function isSummarizeOption(
  option: RestoreOption | null,
): option is 'summarize' | 'summarize_up_to' {
  return option === 'summarize' || option === 'summarize_up_to'
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

/**
 * Computes the diff stats for all the file edits in-between two messages.
 */
export function computeDiffStatsBetweenMessages(
  messages: Message[],
  fromMessageId: UUID,
  toMessageId: UUID | undefined,
): DiffStats | undefined {
  const startIndex = messages.findIndex((msg) => msg.uuid === fromMessageId)
  if (startIndex === -1) {
    return undefined
  }
  let endIndex = toMessageId
    ? messages.findIndex((msg) => msg.uuid === toMessageId)
    : messages.length
  if (endIndex === -1) {
    endIndex = messages.length
  }
  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  for (let i = startIndex + 1; i < endIndex; i++) {
    const msg = messages[i]
    if (!msg || !isToolUseResultMessage(msg)) {
      continue
    }
    const result = msg.toolUseResult as FileEditOutput | FileWriteToolOutput
    if (!result?.filePath || !result.structuredPatch) {
      continue
    }
    if (!filesChanged.includes(result.filePath)) {
      filesChanged.push(result.filePath)
    }
    try {
      if ('type' in result && result.type === 'create') {
        insertions += result.content.split(/\r?\n/).length
      } else {
        for (const hunk of result.structuredPatch) {
          const additions = count(hunk.lines, (line) => line.startsWith('+'))
          const removals = count(hunk.lines, (line) => line.startsWith('-'))
          insertions += additions
          deletions += removals
        }
      }
    } catch {
      // 忽略损坏 patch，保持选择器可用。
    }
  }
  return {
    filesChanged,
    insertions,
    deletions,
  }
}

export function selectableUserMessagesFilter(message: Message): message is UserMessage {
  if (message.type !== 'user') {
    return false
  }
  if (
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'tool_result'
  ) {
    return false
  }
  if (isSyntheticMessage(message)) {
    return false
  }
  if (message.isMeta) {
    return false
  }
  if (message.isCompactSummary || message.isVisibleInTranscriptOnly) {
    return false
  }
  const content = message.message.content
  const lastBlock = content[content.length - 1]
  const messageText = lastBlock && isTextBlock(lastBlock) ? lastBlock.text.trim() : ''

  // 过滤非用户亲自输入的系统产物，避免把恢复目标落在命令输出或通知上。
  if (
    messageText.indexOf(`<${LOCAL_COMMAND_STDOUT_TAG}>`) !== -1 ||
    messageText.indexOf(`<${LOCAL_COMMAND_STDERR_TAG}>`) !== -1 ||
    messageText.indexOf(`<${BASH_STDOUT_TAG}>`) !== -1 ||
    messageText.indexOf(`<${BASH_STDERR_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TASK_NOTIFICATION_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TICK_TAG}>`) !== -1 ||
    messageText.indexOf(`<${TEAMMATE_MESSAGE_TAG}`) !== -1
  ) {
    return false
  }
  return true
}

/**
 * Checks if all messages after the given index are synthetic (interruptions, cancels, etc.)
 * or non-meaningful content.
 */
export function messagesAfterAreOnlySynthetic(messages: Message[], fromIndex: number): boolean {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) {
      continue
    }

    if (isSyntheticMessage(msg)) {
      continue
    }
    if (isToolUseResultMessage(msg)) {
      continue
    }
    if (msg.type === 'progress' || msg.type === 'system' || msg.type === 'attachment') {
      continue
    }
    if (msg.type === 'user' && msg.isMeta) {
      continue
    }

    if (msg.type === 'assistant') {
      const content = msg.message.content
      if (Array.isArray(content)) {
        const hasMeaningfulContent = content.some(
          (block) => (block.type === 'text' && block.text.trim()) || block.type === 'tool_call',
        )
        if (hasMeaningfulContent) {
          return false
        }
      }
      continue
    }

    if (msg.type === 'user') {
      return false
    }
  }
  return true
}
