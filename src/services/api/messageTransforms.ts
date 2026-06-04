import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { isConnectorTextBlock } from '../../types/connectorText.js'
import type {
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  LLMMessage,
  ToolResultBlock,
} from '../../types/llm.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { logForDebugging } from '../../utils/debug.js'
import { logEvent } from '../analytics/index.js'
import { pinCacheEdits } from '../compact/microCompact.js'
import { getCacheControl } from './cacheControl.js'

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  _querySource?: QuerySource,
): LLMMessage {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl(),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl() }
              : {}
            : {}),
        })),
      }
    }
  }
  // 克隆数组内容以防止原地修改（例如 insertCacheEditsBlock 的
  // splice）污染原始消息。如果不克隆，多次调用
  // addCacheBreakpoints 会共享同一数组，每次都在其中插入重复的 cache_edits。
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  _querySource?: QuerySource,
): LLMMessage {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl(),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl() }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

function isMedia(block: ContentBlock): block is ImageBlock | DocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

/**
 * 确保消息最多包含 `limit` 个媒体项（图片 + 文档）。
 * 首先移除最旧的媒体以保留最新的。
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) {
      continue
    }
    for (const block of msg.message.content) {
      if (isMedia(block)) {
        toRemove++
      }
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) {
            toRemove++
          }
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) {
    return messages
  }

  return messages.map((msg) => {
    if (toRemove <= 0) {
      return msg
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      return msg
    }

    const before = toRemove
    const stripped = content
      .map((block) => {
        if (toRemove <= 0 || !isToolResult(block) || !Array.isArray(block.content)) {
          return block
        }
        const filtered = block.content.filter((n) => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length ? block : { ...block, content: filtered }
      })
      .filter((block) => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

function isToolResultBlock(block: unknown): block is ToolResultBlock & { toolCallId: string } {
  return (
    block != null &&
    typeof block === 'object' &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

export type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// 导出用于测试 cache_reference 放置约束
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): LLMMessage[] {
  logEvent('zy_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // 每个请求恰好一个消息级 cache_control 标记。Mycro 的
  // 逐轮驱逐（page_manager/index.rs: Index::insert）会释放
  // 不在 cache_store_int_token_boundaries 中的缓存前缀位置
  // 的局部注意力 KV 页面。如果有两个标记，倒数第二个
  // 位置会被保护，其局部页面会多存活一轮，尽管
  // 永远不会从那里恢复 — 如果只有一个标记则立即释放。
  // 对于即发即弃的分叉（skipCacheWrite），我们将标记移到
  // 倒数第二个消息：那是最后的共享前缀点，因此写入对 mycro
  // 是空合并（条目已存在），分叉也不会在 KVCC 中留下自己的尾部。
  // Dense 页面无论如何都会通过新哈希被引用计数并保留。
  // 跳过末尾的 isMeta 消息（如 max_output_tokens recovery），它们不会被持久化到
  // 会话历史中，在此处打缓存标记会导致下一轮前缀不匹配、缓存失效。
  let markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  while (markerIndex > 0 && messages[markerIndex]?.isMeta) {
    markerIndex--
  }
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
    }
    return assistantMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
  })

  if (!useCachedMC) {
    return result
  }

  // 跟踪所有被删除的 cache_references，防止跨块重复。
  const seenDeleteRefs = new Set<string>()

  // 辅助函数：对 cache_edits 块去重，排除已见过的删除项
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter((edit) => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // 在原始位置重新插入所有之前固定的 cache_edits
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // 将新的 cache_edits 插入最后一条用户消息并固定
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // 固定以便在将来的调用中在同一位置重新发送此块
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map((e) => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // 向缓存前缀范围内的 tool_result 块添加 cache_reference。
  // 必须在 cache_edits 插入之后执行，因为那会修改 content 数组。
  if (enablePromptCaching) {
    // 查找包含 cache_control 标记的最后一条消息
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // 向严格位于最后 cache_control 标记之前的 tool_result 块
    // 添加 cache_reference。API 要求 cache_reference 出现在
    // 最后一个 cache_control"之前或之上" — 我们使用严格"之前"
    // 以避免 cache_edits 拼接改变块索引的边界情况。
    //
    // 创建新对象而非原地修改，以避免污染被
    // 不支持 cache_editing 的模型的次要查询复用的块。
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.toolCallId,
            })
          }
        }
      }
    }
  }

  return result
}
