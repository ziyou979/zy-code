import { feature } from 'bun:bundle'
import { isConnectorTextBlock } from '../../types/connectorText.js'
import type { ContentBlock, RedactedThinkingBlock, ThinkingBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'

import { isToolReferenceBlock } from '../../services/tool-runtime/toolSearch.js'

/**
 * 已完成 turn 的 UI-only 消息类型（progress/stream 等），可安全丢弃。
 *
 * 这些消息：
 *   1. 已被 normalizeMessagesForAPI 过滤，永远不发送给模型
 *   2. 已被其他机制持久化：
 *      - buildPostCompactMessages 不保留 progress
 *      - recordTranscript 已在消息产生时即时写入磁盘
 */
const UI_ONLY_MESSAGE_TYPES = new Set<string>([
  'progress',
  'stream_event',
  'stream_request_start',
  'request_start',
  'tombstone',
])

/**
 * 这些 attachment 子类型是纯 UI 状态信号，不会 reinject 给模型
 * （参见 stripReinjectedAttachments 反向集合）。
 */
const UI_ONLY_ATTACHMENT_SUBTYPES = new Set<string>([
  'hook_success',
  'hook_cancelled',
  'hook_stopped_continuation',
])

/** 估算单条消息字节数（profiler 相对比较用，不要求精确）。 */
function estimateMessageBytes(msg: Message): number {
  try {
    return JSON.stringify(msg).length
  } catch {
    return 0
  }
}

/** 判断 progress 消息是否值得"瘦身"（截断 fullOutput / 内嵌 message）。 */
function shrinkProgressData(msg: ProgressMessage): ProgressMessage {
  const data = msg.data as { type?: string; [k: string]: unknown }
  const dataType = data?.type
  // ShellProgress：fullOutput 是 transcript 复制用全文，已落盘，可清空
  if (dataType === 'bash_progress' || dataType === 'powershell_progress') {
    if ((data as { fullOutput?: string }).fullOutput) {
      return {
        ...msg,
        data: { ...data, fullOutput: '' } as ProgressMessage['data'],
      }
    }
    return msg
  }
  // AgentToolProgress / SkillToolProgress：内嵌完整子消息，已通过其他路径记录
  if (dataType === 'agent_progress' || dataType === 'skill_progress') {
    if ('message' in data && data.message) {
      return {
        ...msg,
        data: { ...data, message: undefined } as unknown as ProgressMessage['data'],
      }
    }
    return msg
  }
  return msg
}

export type PruneResult = {
  messages: Message[]
  /** 释放的字节数估算（profiler / 调试用）。 */
  freedBytes: number
  /** 被丢弃的消息数。 */
  droppedCount: number
  /** 被瘦身（保留但裁字段）的消息数。 */
  shrunkCount: number
}

/**
 * 清理已完成 turn 的 UI-only 临时消息，释放内存。
 *
 * 安全保证：
 *   1. **绝不动** user / assistant / 任何 tool_result（这些是模型上下文）
 *   2. **绝不动** 会被 reinject 的 attachment（file/image/memory/text/diagnostics）
 *   3. **保留**最近一个 user 消息及其之后的全部消息（最新 turn UI 仍在用）
 *   4. 仅丢弃 / 瘦身：progress、stream_event、stream_request_start、request_start、
 *      tombstone、UI-only attachment
 */
export function pruneCompletedTurnArtifacts(messages: readonly Message[]): PruneResult {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === 'user') {
      lastUserIdx = i
      break
    }
  }

  let freedBytes = 0
  let droppedCount = 0
  const shrunkCount = 0

  const result: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (i >= lastUserIdx) {
      result.push(msg)
      continue
    }

    const msgType: string = msg.type

    if (UI_ONLY_MESSAGE_TYPES.has(msgType)) {
      // progress 可瘦身——但历史 turn 中保留意义不大，直接丢弃更省。
      freedBytes += estimateMessageBytes(msg)
      droppedCount++
      continue
    }

    if (msgType === 'attachment') {
      const attachmentType = (msg as AttachmentMessage).attachment?.type
      if (attachmentType && UI_ONLY_ATTACHMENT_SUBTYPES.has(attachmentType)) {
        freedBytes += estimateMessageBytes(msg)
        droppedCount++
        continue
      }
    }

    result.push(msg)
  }

  return { messages: result, freedBytes, droppedCount, shrunkCount }
}

/**
 * 单独导出 progress 瘦身工具，供需要"保留 progress 但裁大字段"的场景。
 * 当前 pruneCompletedTurnArtifacts 选择直接丢弃历史 progress（更彻底），
 * 但保留此 helper 以便未来切换策略。
 */
export function shrinkHistoricalProgress(msg: ProgressMessage): ProgressMessage {
  return shrinkProgressData(msg)
}

type ThinkingBlockType = ThinkingBlock | RedactedThinkingBlock

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlockType {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

/**
 * 从 assistant 消息中剥离带签名的块（thinking、redacted_thinking、connector_text）。
 * 签名绑定生成它们的 API key；凭证变更后（如 /login）签名失效，API 会以 400 拒绝。
 */
export function stripSignatureBlocks(messages: Message[]): Message[] {
  let changed = false
  const result = messages.map((msg) => {
    if (msg.type !== 'assistant') {
      return msg
    }

    const content = msg.message.content
    if (!Array.isArray(content)) {
      return msg
    }

    const filtered = content.filter((block) => {
      if (isThinkingBlock(block)) {
        return false
      }
      if (feature('CONNECTOR_TEXT')) {
        if (isConnectorTextBlock(block)) {
          return false
        }
      }
      return true
    })
    if (filtered.length === content.length) {
      return msg
    }

    // 即使仅 thinking 消息也剥为 []。流式传输将每个内容块生成为单独相同 id 的
    // AssistantMessage（zy.ts:2150），因此此处的 thinking 单例通常是被拆分兄弟，
    // mergeAssistantMessages 会将其与 text/tool_use 伙伴合并。返回原始消息则
    // 过期签名会在合并后存活。空内容会被合并吸收；真正孤立的由
    // normalizeMessagesForAPI 中空内容占位符路径处理。
    changed = true
    return {
      ...msg,
      message: { ...msg.message, content: filtered },
    } as typeof msg
  })

  return changed ? result : messages
}

/**
 * 从 assistant 消息的 tool_use 块中剥离 'caller' 字段。
 * 'caller' 仅在工具搜索 beta 启用时有效；未启用时需移除以避免 API 错误。
 *
 * 此函数仅剥 'caller' — 不标准化工具输入
 * （由 normalizeMessagesForAPI 中的 normalizeToolInputForAPI 完成）。
 * 用于模型特定的后处理，在 normalizeMessagesForAPI 之后调用，
 * 因此输入已标准化。
 */
export function stripCallerFieldFromAssistantMessage(message: AssistantMessage): AssistantMessage {
  if (!Array.isArray(message.message.content)) {
    return message
  }
  const hasCallerField = message.message.content.some(
    (block) => block.type === 'tool_call' && 'caller' in block && block.caller !== null,
  )

  if (!hasCallerField) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map((block) => {
        if (block.type !== 'tool_call') {
          return block
        }
        return {
          type: 'tool_call' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }),
    },
  }
}

/**
 * 从 tool_result 内容中剥离 tool_reference 块。
 * tool_reference 块仅在工具搜索 beta 启用时有效；未启用时需移除以避免 API 错误。
 */
export function stripToolReferenceBlocksFromUserMessage(message: UserMessage): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  const hasToolReference = content.some(
    (block) =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )

  if (!hasToolReference) {
    return message
  }

  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
          return block
        }

        const filteredContent = block.content.filter((c) => !isToolReferenceBlock(c))

        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: '[Tool references removed - tool search not enabled]',
              },
            ],
          }
        }

        return {
          ...block,
          content: filteredContent,
        }
      }),
    },
  }
}
