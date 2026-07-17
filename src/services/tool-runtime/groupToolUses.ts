import type { Tools } from '../../tools/tool.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  GroupedToolUseMessage,
  RenderableMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'

export type MessageWithoutProgress =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage

export type GroupingResult = {
  messages: RenderableMessage[]
}

// 缓存支持分组渲染的工具名称集合，以 tools 数组引用作为键。
// tools 数组在渲染期间保持稳定（仅在 MCP 连接/断开时替换），
// 因此无需在每次调用时重建集合。WeakMap 允许旧条目在数组被替换后被垃圾回收。
const GROUPING_CACHE = new WeakMap<Tools, Set<string>>()

function getToolsWithGrouping(tools: Tools): Set<string> {
  let cached = GROUPING_CACHE.get(tools)
  if (!cached) {
    cached = new Set(tools.filter((t) => t.renderGroupedToolUse).map((t) => t.name))
    GROUPING_CACHE.set(tools, cached)
  }
  return cached
}

function getToolUseInfo(
  msg: MessageWithoutProgress,
): { messageId: string; toolUseId: string; toolName: string } | null {
  if (!('message' in msg) || !msg.message) {
    return null
  }
  const assistantMsg = msg as import('../../types/message.js').AssistantMessage
  const firstBlock = assistantMsg.message.content[0]
  if (firstBlock && firstBlock.type === 'tool_call') {
    return {
      messageId: assistantMsg.message.id as string,
      toolUseId: firstBlock.id,
      toolName: firstBlock.name,
    }
  }
  return null
}

/**
 * 按 message.id（同一 API 响应）对工具调用进行分组，前提是该工具支持分组渲染。
 * 仅对来自同一消息的 2 个及以上相同类型的工具调用进行分组。
 * 同时收集对应的 tool_results 并附加到分组消息上。
 * 当 verbose 为 true 时，跳过分组，使消息在原始位置渲染。
 */
export function applyGrouping(
  messages: MessageWithoutProgress[],
  tools: Tools,
  verbose: boolean = false,
): GroupingResult {
  // verbose 模式下不进行分组，每条消息在其原始位置渲染
  if (verbose) {
    return {
      messages: messages,
    }
  }
  const toolsWithGrouping = getToolsWithGrouping(tools)

  // 第一轮遍历：按 message.id + 工具名称对工具调用进行分组
  const groups = new Map<string, AssistantMessage[]>()

  for (const msg of messages) {
    const info = getToolUseInfo(msg)
    if (info && toolsWithGrouping.has(info.toolName)) {
      const key = `${info.messageId}:${info.toolName}`
      const group = groups.get(key) ?? []
      group.push(msg as AssistantMessage)
      groups.set(key, group)
    }
  }

  // 识别有效分组（2 个及以上条目）并收集其工具调用 ID
  const validGroups = new Map<string, AssistantMessage[]>()
  const groupedToolUseIds = new Set<string>()

  for (const [key, group] of groups) {
    if (group.length >= 2) {
      validGroups.set(key, group)
      for (const msg of group) {
        const info = getToolUseInfo(msg)
        if (info) {
          groupedToolUseIds.add(info.toolUseId)
        }
      }
    }
  }

  // 收集已分组 tool_uses 的结果消息
  // 从 tool_use_id 映射到包含该结果的用户消息
  const resultsByToolUseId = new Map<string, UserMessage>()

  for (const msg of messages) {
    if (msg.type === 'user') {
      for (const content of msg.message.content) {
        if (content.type === 'tool_result' && groupedToolUseIds.has(content.toolCallId)) {
          resultsByToolUseId.set(content.toolCallId, msg)
        }
      }
    }
  }

  // 第二轮遍历：构建输出，每个分组仅输出一次
  const result: RenderableMessage[] = []
  const emittedGroups = new Set<string>()

  for (const msg of messages) {
    const info = getToolUseInfo(msg)

    if (info) {
      const key = `${info.messageId}:${info.toolName}`
      const group = validGroups.get(key)

      if (group) {
        if (!emittedGroups.has(key)) {
          emittedGroups.add(key)
          const firstMsg = group[0]!

          // 收集该分组的结果
          const results: UserMessage[] = []
          for (const assistantMsg of group) {
            const contentBlocks = assistantMsg.message.content
            const firstBlock = contentBlocks[0]
            if (firstBlock && firstBlock.type === 'tool_call') {
              const toolUseId = firstBlock.id
              const resultMsg = resultsByToolUseId.get(toolUseId)
              if (resultMsg) {
                results.push(resultMsg)
              }
            }
          }

          const groupedMessage: GroupedToolUseMessage = {
            type: 'grouped_tool_use',
            toolName: info.toolName,
            messages: group,
            results: results,
            displayMessage: firstMsg,
            uuid: `grouped-${firstMsg.uuid}`,
            timestamp: firstMsg.timestamp,
            messageId: info.messageId,
            toolUses: group
              .map((m) => {
                const blocks = m.message.content
                const block = blocks[0]
                return block && block.type === 'tool_call' ? block : null
              })
              .filter((b): b is NonNullable<typeof b> => b !== null),
          }
          result.push(groupedMessage)
        }
        continue
      }
    }

    // 跳过其所有 tool_results 均已被分组的用户消息
    if (msg.type === 'user') {
      const toolResults = msg.message.content.filter(
        (c): c is ToolResultBlock => c.type === 'tool_result',
      )
      if (toolResults.length > 0) {
        const allGrouped = toolResults.every((tr) => groupedToolUseIds.has(tr.toolCallId))
        if (allGrouped) {
          continue
        }
      }
    }

    result.push(msg)
  }

  return { messages: result }
}
