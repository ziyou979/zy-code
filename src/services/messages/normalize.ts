import { type UUID } from 'node:crypto'
import isObject from 'lodash-es/isObject.js'
import last from 'lodash-es/last.js'
import { getNoContentMessage } from '../../constants/messages.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { findToolByName, type Tools } from '../../tools/Tool.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantContentBlock,
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  UserContentBlock,
} from '../../types/llm.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { normalizeToolInput } from '../../utils/api.js'
import { logAntError, logForDebugging } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { isToolReferenceBlock } from '../../utils/toolSearch.js'
import { createUserMessage } from './constructors.js'
import { deriveUUID } from './predicates.js'
import { isThinkingBlock } from './prune.js'

void logAntError // placeholder retained for future warnings

// 拆分消息，使每个内容块获得自己的消息
export function normalizeMessages(messages: AssistantMessage[]): AssistantMessage[]
export function normalizeMessages(messages: UserMessage[]): UserMessage[]
export function normalizeMessages(
  messages: (AssistantMessage | UserMessage)[],
): (AssistantMessage | UserMessage)[]
export function normalizeMessages(messages: Message[]): Message[]
export function normalizeMessages(messages: Message[]): Message[] {
  // isNewChain：当消息含多内容块时拆分成多条单内容块消息，
  // 此时后续消息需新生 UUID 以维持排序并防 UUID 重复。
  // 一旦遇到多块消息此标志为 true，并对所有后续消息保持为 true。
  let isNewChain = false
  return messages.flatMap<Message>((message) => {
    switch (message.type) {
      case 'assistant': {
        const content = message.message.content
        if (!Array.isArray(content)) {
          return []
        }
        isNewChain = isNewChain || content.length > 1
        return content.map((_, index) => {
          const uuid = isNewChain ? deriveUUID(message.uuid as UUID, index) : message.uuid
          return {
            type: 'assistant' as const,
            timestamp: message.timestamp,
            message: {
              ...message.message,
              content: [_],
              context_management: message.message.context_management ?? null,
            },
            isMeta: message.isMeta,
            isVirtual: message.isVirtual,
            requestId: message.requestId,
            uuid,
            error: message.error,
            isApiErrorMessage: message.isApiErrorMessage,
            ...(message.thinkingDurationMs !== undefined && {
              thinkingDurationMs: message.thinkingDurationMs,
            }),
          } as AssistantMessage
        })
      }
      case 'attachment':
        return [message]
      case 'progress':
        return [message]
      case 'system':
        return [message]
      case 'user': {
        if (typeof message.message.content === 'string') {
          const uuid = isNewChain ? deriveUUID(message.uuid as UUID, 0) : message.uuid
          return [
            {
              ...message,
              uuid,
              message: {
                ...message.message,
                content: [{ type: 'text', text: message.message.content }],
              },
            } as UserMessage,
          ]
        }
        isNewChain = isNewChain || message.message.content.length > 1
        let imageIndex = 0
        return message.message.content.map((_, index) => {
          const isImage = _.type === 'image'
          const imageId =
            isImage && message.imagePasteIds ? message.imagePasteIds[imageIndex] : undefined
          if (isImage) {
            imageIndex++
          }
          return {
            ...createUserMessage({
              content: [_],
              toolUseResult: message.toolUseResult,
              mcpMeta: message.mcpMeta,
              isMeta: message.isMeta || undefined,
              isVisibleInTranscriptOnly: message.isVisibleInTranscriptOnly,
              isVirtual: message.isVirtual,
              timestamp: message.timestamp,
              imagePasteIds: imageId !== undefined ? [imageId] : undefined,
              origin: message.origin,
            }),
            uuid: isNewChain ? deriveUUID(message.uuid as UUID, index) : message.uuid,
          } as UserMessage
        })
      }
      default:
        return []
    }
  })
}

export function mergeUserMessagesAndToolResults(a: UserMessage, b: UserMessage): UserMessage {
  const lastContent = normalizeUserTextContent(a.message.content)
  const currentContent = normalizeUserTextContent(b.message.content)
  return {
    ...a,
    message: {
      ...a.message,
      content: hoistToolResults(mergeUserContentBlocks(lastContent, currentContent)),
    },
  }
}

export function mergeAssistantMessages(a: AssistantMessage, b: AssistantMessage): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [
        ...(Array.isArray(a.message.content) ? a.message.content : []),
        ...(Array.isArray(b.message.content) ? b.message.content : []),
      ],
    },
  }
}

export function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  const lastContent = normalizeUserTextContent(a.message.content)
  const currentContent = normalizeUserTextContent(b.message.content)
  return {
    ...a,
    // 保留非 meta 消息的 uuid，使 [id:] 标签（从 uuid 派生）在 API 调用间稳定
    //（meta 消息每次调用获得新 uuid）
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: hoistToolResults(joinTextAtSeam(lastContent, currentContent)),
    },
  }
}

export function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') {
    return false
  }
  const content = msg.message.content
  if (typeof content === 'string') {
    return false
  }
  return content.some((block) => block.type === 'tool_result')
}

export function mergeAdjacentUserMessages(
  msgs: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  for (const m of msgs) {
    const prev = out.at(-1)
    if (m.type === 'user' && prev?.type === 'user') {
      out[out.length - 1] = mergeUserMessages(prev, m) // 左值赋值 — 不可用 .at()
    } else {
      out.push(m)
    }
  }
  return out
}

function hoistToolResults(content: UserContentBlock[]): UserContentBlock[] {
  const toolResults: UserContentBlock[] = []
  const otherBlocks: UserContentBlock[] = []

  for (const block of content) {
    if (block.type === 'tool_result') {
      toolResults.push(block)
    } else {
      otherBlocks.push(block)
    }
  }

  return [...toolResults, ...otherBlocks]
}

function normalizeUserTextContent(a: string | UserContentBlock[]): UserContentBlock[] {
  if (typeof a === 'string') {
    return [{ type: 'text', text: a }]
  }
  return a
}

/**
 * 拼接两个内容块数组：当拼接处为 text-text 时在 a 的最后一个文本块后追加 `\n`。
 * API 会将用户消息中相邻的文本块无分隔符拼接，因此两个排队的 prompt
 * `"2 + 2"` + `"3 + 3"` 如不处理会以 `"2 + 23 + 3"` 到达模型。
 *
 * `\n` 加在 a 侧不改变任何块的 startsWith — smooshSystemReminderSiblings
 * 通过 startsWith('<system-reminder>') 分类，前缀到 b 侧会破坏该判断。
 */
function joinTextAtSeam(a: UserContentBlock[], b: UserContentBlock[]): UserContentBlock[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: `${lastA.text}\n` }, ...b]
  }
  return [...a, ...b]
}

type ToolResultContentItem = Extract<ToolResultBlock['content'], readonly unknown[]>[number]

/**
 * 将内容块折叠到 tool_result.content 中。tool_reference 约束不可行则返 null。
 *
 * 有效块类型：text、image、search_result、document（均可折叠）。
 * tool_reference（beta）不能与其他类型混合 — 服务器报 ValueError — 返 null。
 */
export function smooshIntoToolResult(
  tr: ToolResultBlock,
  blocks: ContentBlock[],
): ToolResultBlock | null {
  if (blocks.length === 0) {
    return tr
  }

  const existing = tr.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) {
    return null
  }

  // API 约束：is_error 的 tool_result 必须只含 text 块。
  // 队列命令的兄弟节点可能携带图片（粘贴截图） — smoosh 到错误结果会产生
  // 每次后续调用都 400 且无法 /fork 恢复的记录。图片不丢失：作为正常 user 轮次到达。
  if (tr.isError) {
    blocks = blocks.filter((b) => b.type === 'text')
    if (blocks.length === 0) {
      return tr
    }
  }

  const allText = blocks.every((b) => b.type === 'text')

  // existing 为 string/undefined 且全块为 text 时保留字符串形态 —
  // 常见情况（向 Bash/Read 结果注入 hook 提醒），且与旧版 smoosh 输出一致。
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const joined = [
      ((existing as string) ?? '').trim(),
      ...blocks.map((b) => (b as TextBlock).text.trim()),
    ]
      .filter(Boolean)
      .join('\n\n')
    return { ...tr, content: joined }
  }

  const base: ToolResultContentItem[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? existing.trim()
          ? [{ type: 'text', text: existing.trim() }]
          : []
        : [...existing]

  const merged: ToolResultContentItem[] = []
  for (const b of [...base, ...blocks]) {
    if (b.type === 'text') {
      const t = b.text.trim()
      if (!t) {
        continue
      }
      const prev = merged.at(-1)
      if (prev?.type === 'text') {
        merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${t}` }
      } else {
        merged.push({ type: 'text', text: t })
      }
    } else {
      merged.push(b as ToolResultContentItem)
    }
  }

  return { ...tr, content: merged }
}

export function mergeUserContentBlocks(
  a: UserContentBlock[],
  b: UserContentBlock[],
): UserContentBlock[] {
  // tool_result 之后的任何兄弟节点在线上会渲染为 </function_results>\n\nHuman:<...>。
  // 反复出现时教 capy 在尾部裸发 Human: → 3-token 空 end_turn。
  // A/B 测试验证：smoosh 到 tool_result.content → 92% → 0%。
  const lastBlock = last(a)
  if (lastBlock?.type !== 'tool_result') {
    return [...a, ...b]
  }

  if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_sysreminder_smoosh', false)) {
    // 旧版 smoosh：仅 string-content tool_result + 全 text 兄弟 → 连接字符串。
    // 前置条件保证 smooshIntoToolResult 命中字符串路径。
    if (typeof lastBlock.content === 'string' && b.every((x) => x.type === 'text')) {
      const copy = a.slice()
      copy[copy.length - 1] = smooshIntoToolResult(lastBlock, b)!
      return copy
    }
    return [...a, ...b]
  }

  // 通用 smoosh（门控）：将所有非 tool_result 块（text/image/document/search_result）
  // 折叠到 tool_result.content。tool_result 块保持兄弟（稍后由 hoistToolResults 提升）。
  const toSmoosh = b.filter((x) => x.type !== 'tool_result')
  const toolResults = b.filter((x) => x.type === 'tool_result')
  if (toSmoosh.length === 0) {
    return [...a, ...b]
  }

  const smooshed = smooshIntoToolResult(lastBlock, toSmoosh)
  if (smooshed === null) {
    // tool_reference 约束 — 回退到兄弟
    return [...a, ...b]
  }

  return [...a.slice(0, -1), smooshed, ...toolResults]
}

/**
 * API 有时返回空消息（如 "\n\n"），下次 query() 调用会触发 API 错误，需过滤。
 */
export function normalizeContentFromAPI(
  contentBlocks: ContentBlock[],
  tools: Tools,
  agentId?: AgentId,
): ContentBlock[] {
  if (!contentBlocks) {
    return []
  }
  return contentBlocks.map((contentBlock) => {
    const block = contentBlock as {
      type: string
      input?: unknown
      id?: string
      name?: string
      text?: string
      [key: string]: unknown
    }
    switch (block.type) {
      case 'tool_use':
      case 'tool_call': {
        // 同时覆盖 'tool_use'（v1 / Anthropic）和 'tool_call'（v2 / OpenAI）。
        // OpenAI 适配器（mapOpenAIStreamToStandard）流式累积阶段产出 chunk.type='tool_call'，
        // input 以字符串形式累积，须在此 parse 回 object，否则下一轮 messagesToOpenAI
        // 对字符串 JSON.stringify 会双重转义，触发 DashScope 400。
        if (typeof block.input !== 'string' && !isObject(block.input)) {
          throw new Error('Tool use input must be a string or object')
        }

        // 启用细粒度流式后从 API 获取的是序列化 JSON 字符串。
        // API 会返回嵌套序列化 JSON，因此递归解析。空字符串应变空对象。
        let normalizedInput: unknown
        if (typeof block.input === 'string') {
          const parsed = safeParseJSON(block.input)
          if (parsed === null && block.input.length > 0) {
            // TET/FC-v3 诊断：流式 tool 输入 JSON 解析失败。回退到 {}。
            logEvent('zy_tool_input_json_parse_fail', {
              toolName: sanitizeToolNameForAnalytics(block.name ?? ''),
              inputLen: block.input.length,
            })
            if (isInternalBuild()) {
              logForDebugging(`tool input JSON parse fail: ${block.input.slice(0, 200)}`, {
                level: 'warn',
              })
            }
          }
          normalizedInput = parsed ?? {}
        } else {
          normalizedInput = block.input
        }

        // 应用 tool-specific 修正
        if (typeof normalizedInput === 'object' && normalizedInput !== null) {
          const tool = findToolByName(tools, block.name ?? '')
          if (tool) {
            try {
              normalizedInput = normalizeToolInput(
                tool,
                normalizedInput as { [key: string]: unknown },
                agentId,
              )
            } catch (error) {
              logError(new Error(`Error normalizing tool input: ${error}`))
            }
          }
        }

        return {
          ...contentBlock,
          input: normalizedInput,
        } as AssistantContentBlock
      }
      case 'text':
        if ((block.text as string).trim().length === 0) {
          logEvent('zy_model_whitespace_response', {
            length: (block.text as string).length,
          })
        }
        // 原样返回保留精确内容用于 prompt 缓存。空 text 块在展示层处理。
        return contentBlock
      case 'code_execution_tool_result':
      case 'mcp_tool_use':
      case 'mcp_tool_result':
      case 'container_upload':
      default:
        return contentBlock
    }
  })
}

// ============================================================
// filter 系列：清理 API 不接受的空白 / 孤立 thinking 等
// ============================================================

/**
 * 过滤最后一条 assistant 消息末尾的 thinking 块。
 * API 不允许 assistant 消息以 thinking/redacted_thinking 块结尾。
 */
export function filterTrailingThinkingFromLastAssistant(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.type !== 'assistant') {
    return messages
  }

  const content = lastMessage.message.content
  if (!Array.isArray(content)) {
    return messages
  }
  const lastBlock = content.at(-1)
  if (!lastBlock || !isThinkingBlock(lastBlock)) {
    return messages
  }

  let lastValidIndex = content.length - 1
  while (lastValidIndex >= 0) {
    const block = content[lastValidIndex]
    if (!block || !isThinkingBlock(block)) {
      break
    }
    lastValidIndex--
  }

  logEvent('zy_filtered_trailing_thinking_block', {
    messageUUID: lastMessage.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    blocksRemoved: content.length - lastValidIndex - 1,
    remainingBlocks: lastValidIndex + 1,
  })

  const filteredContent =
    lastValidIndex < 0
      ? [{ type: 'text' as const, text: '[No message content]', citations: [] }]
      : content.slice(0, lastValidIndex + 1)

  const result = [...messages]
  result[messages.length - 1] = {
    ...lastMessage,
    message: {
      ...lastMessage.message,
      content: filteredContent,
    },
  }
  return result
}

/**
 * 检查 assistant 消息是否仅含纯空白 text 内容块。
 */
function hasOnlyWhitespaceTextContent(content: Array<{ type: string; text?: string }>): boolean {
  if (content.length === 0) {
    return false
  }

  for (const block of content) {
    if (block.type !== 'text') {
      return false
    }
    if (block.text !== undefined && block.text.trim() !== '') {
      return false
    }
  }

  return true
}

/**
 * 过滤仅含纯空白 text 内容的 assistant 消息。
 * API 要求"text 内容块必须包含非空白文本"。
 * 也被 conversationRecovery 在会话恢复时用于从主状态过滤。
 */
export function filterWhitespaceOnlyAssistantMessages(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[]
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  let hasChanges = false

  const filtered = messages.filter((message) => {
    if (message.type !== 'assistant') {
      return true
    }

    const content = message.message.content
    if (!Array.isArray(content) || content.length === 0) {
      return true
    }

    if (hasOnlyWhitespaceTextContent(content)) {
      hasChanges = true
      logEvent('zy_filtered_whitespace_only_assistant', {
        messageUUID: message.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return false
    }

    return true
  })

  if (!hasChanges) {
    return messages
  }

  // 移除 assistant 消息后可能留下需合并的相邻 user 消息（API 要求交替）。
  const merged: Message[] = []
  for (const message of filtered) {
    const prev = merged.at(-1)
    if (message.type === 'user' && prev?.type === 'user') {
      merged[merged.length - 1] = mergeUserMessages(prev, message)
    } else {
      merged.push(message)
    }
  }
  return merged
}

/**
 * 确保所有非最后一条 assistant 消息具有非空内容。
 *
 * API 要求"所有消息必须具有非空内容，可选的最后一条 assistant 消息除外"。
 * 模型返回空内容数组时可能出现此情况。
 */
export function ensureNonEmptyAssistantContent(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  if (messages.length === 0) {
    return messages
  }

  let hasChanges = false
  const result = messages.map((message, index) => {
    if (message.type !== 'assistant') {
      return message
    }

    if (index === messages.length - 1) {
      return message
    }

    const content = message.message.content
    if (Array.isArray(content) && content.length === 0) {
      hasChanges = true
      logEvent('zy_fixed_empty_assistant_content', {
        messageUUID: message.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        messageIndex: index,
      })

      return {
        ...message,
        message: {
          ...message.message,
          content: [{ type: 'text' as const, text: getNoContentMessage(), citations: [] }],
        },
      }
    }

    return message
  })

  return hasChanges ? result : messages
}

/**
 * 过滤孤立的纯 thinking assistant 消息。
 *
 * 流式期间每个内容块作为相同 message.id 的独立消息产出。
 * 加载消息用于恢复时，穿插的 user 消息或附件可能阻止按 id 合并，
 * 留下仅含 thinking 块的孤立 assistant 消息 — 会触发
 * "thinking blocks cannot be modified" API 错误。
 *
 * 一个纯 thinking 消息被认为"孤立"，当且仅当没有其他相同 id 的 assistant
 * 消息含非 thinking 内容（text/tool_use 等）。否则会在 normalizeMessagesForAPI 中合并。
 */
export function filterOrphanedThinkingOnlyMessages(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[]
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  // 第一轮：收集含非 thinking 内容的 message.id（稍后会在 normalizeMessagesForAPI 合并）
  const messageIdsWithNonThinkingContent = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') {
      continue
    }

    const content = msg.message.content
    if (!Array.isArray(content)) {
      continue
    }

    const hasNonThinking = content.some(
      (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    )
    if (hasNonThinking && msg.message.id) {
      messageIdsWithNonThinkingContent.add(msg.message.id)
    }
  }

  // 第二轮：过滤掉真正孤立的纯 thinking 消息
  const filtered = messages.filter((msg) => {
    if (msg.type !== 'assistant') {
      return true
    }

    const content = msg.message.content
    if (!Array.isArray(content) || content.length === 0) {
      return true
    }

    const allThinking = content.every(
      (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
    )

    if (!allThinking) {
      return true
    }

    if (msg.message.id && messageIdsWithNonThinkingContent.has(msg.message.id)) {
      return true
    }

    // 真正孤立 — 无相同 id 的其他消息有内容可合并
    logEvent('zy_filtered_orphaned_thinking_message', {
      messageUUID: msg.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      messageId: msg.message.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      blockCount: content.length,
    })
    return false
  })

  return filtered
}
