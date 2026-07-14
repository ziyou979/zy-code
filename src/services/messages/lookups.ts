import type { HookEvent } from 'src/types/index.js'
import type { ToolCallBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'
import { count } from '../../utils/array.js'
import type {
  HookAttachment,
  HookPermissionDecisionAttachment,
} from '../attachments/attachments.js'
import { getToolUseID, isHookAttachmentMessage } from './predicates.js'

// 带有 hookName 字段的 Hook 附件（排除 HookPermissionDecisionAttachment）
type HookAttachmentWithName = Exclude<HookAttachment, HookPermissionDecisionAttachment>

function getInProgressHookCount(
  messages: Message[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  return count(
    messages,
    (_) =>
      _.type === 'progress' &&
      _.data.type === 'hook_progress' &&
      _.data.hookEvent === hookEvent &&
      _.parentToolUseID === toolUseID,
  )
}

function getResolvedHookCount(
  messages: Message[],
  toolUseID: string,
  hookEvent: HookEvent,
): number {
  // 单个 hook 可产生多个附件消息（如 hook_success + hook_additional_context），
  // 按 hookName 去重以统计唯一 hook 数。
  const uniqueHookNames = new Set(
    messages
      .filter(
        (_): _ is AttachmentMessage<Record<string, unknown>> =>
          isHookAttachmentMessage(_) &&
          (_.attachment as Record<string, unknown>).toolUseID === toolUseID &&
          (_.attachment as Record<string, unknown>).hookEvent === hookEvent,
      )
      .map((_) => _.attachment.hookName),
  )
  return uniqueHookNames.size
}

export function hasUnresolvedHooks(messages: Message[], toolUseID: string, hookEvent: HookEvent) {
  const inProgressHookCount = getInProgressHookCount(messages, toolUseID, hookEvent)
  const resolvedHookCount = getResolvedHookCount(messages, toolUseID, hookEvent)

  if (inProgressHookCount > resolvedHookCount) {
    return true
  }

  return false
}

export function getToolResultIDs(normalizedMessages: Message[]): {
  [toolUseID: string]: boolean
} {
  return Object.fromEntries(
    normalizedMessages.flatMap((_) =>
      _.type === 'user' && _.message.content[0]?.type === 'tool_result'
        ? [[_.message.content[0].toolCallId, _.message.content[0].isError ?? false]]
        : ([] as [string, boolean][]),
    ),
  )
}

export function getSiblingToolUseIDs(message: Message, messages: Message[]): Set<string> {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) {
    return new Set()
  }

  const unnormalizedMessage = messages.find(
    (_): _ is AssistantMessage =>
      _.type === 'assistant' &&
      _.message.content.some((_) => _.type === 'tool_call' && _.id === toolUseID),
  )
  if (!unnormalizedMessage) {
    return new Set()
  }

  const messageID = unnormalizedMessage.message.id
  const siblingMessages = messages.filter(
    (_): _ is AssistantMessage => _.type === 'assistant' && _.message.id === messageID,
  )

  return new Set(
    siblingMessages.flatMap((_) =>
      _.message.content.filter((_) => _.type === 'tool_call').map((_) => _.id),
    ),
  )
}

export type MessageLookups = {
  siblingToolUseIDs: Map<string, Set<string>>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: Map<string, Map<HookEvent, number>>
  resolvedHookCounts: Map<string, Map<HookEvent, number>>
  /** 将 tool_use_id 映射到包含其 tool_result 的用户消息 */
  toolResultByToolUseID: Map<string, Message>
  /** 将 tool_use_id 映射到 ToolCallBlock */
  toolUseByToolUseID: Map<string, ToolCallBlock>
  /** 标准化消息的总计数（用于截断指示文本） */
  normalizedMessageCount: number
  /** 有对应 tool_result 的工具使用 ID 集合 */
  resolvedToolUseIDs: Set<string>
  /** 有错误 tool_result 的工具使用 ID 集合 */
  erroredToolUseIDs: Set<string>
}

/**
 * 构建预计算查找表，以 O(1) 访问消息关系。每次渲染调用一次。
 * 避免对每条消息调用 getProgressMessagesForMessage/getSiblingToolUseIDs/
 * hasUnresolvedHooks 的 O(n²) 行为。
 */
export function buildMessageLookups(
  normalizedMessages: Message[],
  messages: Message[],
): MessageLookups {
  // 第一遍：按 ID 分组 assistant 消息并收集每条消息的所有工具使用 ID
  const toolUseIDsByMessageID = new Map<string, Set<string>>()
  const toolUseIDToMessageID = new Map<string, string>()
  const toolUseByToolUseID = new Map<string, ToolCallBlock>()
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const id = msg.message.id ?? ''
      let toolUseIDs = toolUseIDsByMessageID.get(id)
      if (!toolUseIDs) {
        toolUseIDs = new Set()
        toolUseIDsByMessageID.set(id, toolUseIDs)
      }
      for (const content of msg.message.content) {
        if (content.type === 'tool_call') {
          toolUseIDs.add(content.id)
          toolUseIDToMessageID.set(content.id, id)
          toolUseByToolUseID.set(content.id, content)
        }
      }
    }
  }

  const siblingToolUseIDs = new Map<string, Set<string>>()
  for (const [toolUseID, messageID] of toolUseIDToMessageID) {
    siblingToolUseIDs.set(toolUseID, toolUseIDsByMessageID.get(messageID)!)
  }

  const progressMessagesByToolUseID = new Map<string, ProgressMessage[]>()
  const inProgressHookCounts = new Map<string, Map<HookEvent, number>>()
  // 按 (toolUseID, hookEvent) 追踪唯一 hook 名称，以匹配 getResolvedHookCount 行为。
  const resolvedHookNames = new Map<string, Map<HookEvent, Set<string>>>()
  const toolResultByToolUseID = new Map<string, Message>()
  const resolvedToolUseIDs = new Set<string>()
  const erroredToolUseIDs = new Set<string>()

  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      const toolUseID = msg.parentToolUseID
      const existing = progressMessagesByToolUseID.get(toolUseID)
      if (existing) {
        existing.push(msg)
      } else {
        progressMessagesByToolUseID.set(toolUseID, [msg])
      }

      if (msg.data.type === 'hook_progress') {
        const hookEvent = msg.data.hookEvent
        let byHookEvent = inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    if (msg.type === 'user') {
      for (const content of msg.message.content) {
        if (content.type === 'tool_result') {
          toolResultByToolUseID.set(content.toolCallId, msg)
          resolvedToolUseIDs.add(content.toolCallId)
          if (content.isError) {
            erroredToolUseIDs.add(content.toolCallId)
          }
        }
      }
    }

    if (msg.type === 'assistant') {
      for (const content of msg.message.content) {
        // 追踪所有服务端 *_tool_result 块（advisor/web_search/code_execution/mcp 等） —
        // 任何带 toolCallId 的块都是结果。
        if (
          'toolCallId' in content &&
          typeof (content as { toolCallId: string }).toolCallId === 'string'
        ) {
          resolvedToolUseIDs.add((content as { toolCallId: string }).toolCallId)
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as unknown as {
            toolCallId: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            erroredToolUseIDs.add(result.toolCallId)
          }
        }
      }
    }

    if (isHookAttachmentMessage(msg)) {
      const hookAttachment = msg.attachment as Record<string, unknown>
      const toolUseID = hookAttachment.toolUseID as string
      const hookEvent = hookAttachment.hookEvent as HookEvent
      const hookName = (hookAttachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        let byHookEvent = resolvedHookNames.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          resolvedHookNames.set(toolUseID, byHookEvent)
        }
        let names = byHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          byHookEvent.set(hookEvent, names)
        }
        names.add(hookName)
      }
    }
  }

  const resolvedHookCounts = new Map<string, Map<HookEvent, number>>()
  for (const [toolUseID, byHookEvent] of resolvedHookNames) {
    const countMap = new Map<HookEvent, number>()
    for (const [hookEvent, names] of byHookEvent) {
      countMap.set(hookEvent, names.size)
    }
    resolvedHookCounts.set(toolUseID, countMap)
  }

  // 标记孤立的 mcp_tool_use 块（无匹配结果）为错误，
  // 使 UI 显示为失败而不是永久旋转。
  const lastMsg = messages.at(-1)
  const lastAssistantMsgId = lastMsg?.type === 'assistant' ? lastMsg.message.id : undefined
  for (const msg of normalizedMessages) {
    if (msg.type !== 'assistant') {
      continue
    }
    if (msg.message.id === lastAssistantMsgId) {
      continue
    }
    for (const content of msg.message.content) {
      if (
        (content.type as string) === 'mcp_tool_use' &&
        !resolvedToolUseIDs.has((content as { id: string }).id)
      ) {
        const id = (content as { id: string }).id
        resolvedToolUseIDs.add(id)
        erroredToolUseIDs.add(id)
      }
    }
  }

  return {
    siblingToolUseIDs,
    progressMessagesByToolUseID,
    inProgressHookCounts,
    resolvedHookCounts,
    toolResultByToolUseID,
    toolUseByToolUseID,
    normalizedMessageCount: normalizedMessages.length,
    resolvedToolUseIDs,
    erroredToolUseIDs,
  }
}

/** 用于不需要真实查找表的静态渲染上下文的空查找表。 */
export const EMPTY_LOOKUPS: MessageLookups = {
  siblingToolUseIDs: new Map(),
  progressMessagesByToolUseID: new Map(),
  inProgressHookCounts: new Map(),
  resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
  normalizedMessageCount: 0,
  resolvedToolUseIDs: new Set(),
  erroredToolUseIDs: new Set(),
}

/**
 * 共享的空 Set 单例。在退出路径上复用以避免每次渲染每条消息都分配新 Set。
 * 编译时通过 ReadonlySet<string> 类型防止修改 — 此处 Object.freeze 仅为约定
 *（冻结自身属性，不冻结 Set 内部状态）。所有消费者均为只读（迭代/.has/.size）。
 */
export const EMPTY_STRING_SET: ReadonlySet<string> = Object.freeze(new Set<string>())

/**
 * 从 subagent/skill 进度消息构建查找表，使子工具使用能以
 * 正确的已解决/进行中/排队状态渲染。
 *
 * 每条进度消息必须有 `message` 字段，类型为
 * `AssistantMessage | UserMessage`.
 */
export function buildSubagentLookups(messages: { message: AssistantMessage | UserMessage }[]): {
  lookups: MessageLookups
  inProgressToolUseIDs: Set<string>
} {
  const toolUseByToolUseID = new Map<string, ToolCallBlock>()
  const resolvedToolUseIDs = new Set<string>()
  const toolResultByToolUseID = new Map<string, UserMessage & { type: 'user' }>()

  for (const { message: msg } of messages) {
    if (msg.type === 'assistant') {
      for (const content of msg.message.content) {
        if (content.type === 'tool_call') {
          toolUseByToolUseID.set(content.id, content as ToolCallBlock)
        }
      }
    } else if (msg.type === 'user') {
      for (const content of msg.message.content) {
        if (content.type === 'tool_result') {
          resolvedToolUseIDs.add(content.toolCallId)
          toolResultByToolUseID.set(content.toolCallId, msg)
        }
      }
    }
  }

  const inProgressToolUseIDs = new Set<string>()
  for (const id of toolUseByToolUseID.keys()) {
    if (!resolvedToolUseIDs.has(id)) {
      inProgressToolUseIDs.add(id)
    }
  }

  return {
    lookups: {
      ...EMPTY_LOOKUPS,
      toolUseByToolUseID,
      resolvedToolUseIDs,
      toolResultByToolUseID,
    },
    inProgressToolUseIDs,
  }
}

/** 使用预计算查找表获取同级工具使用 ID。O(1)。 */
export function getSiblingToolUseIDsFromLookup(
  message: Message,
  lookups: MessageLookups,
): ReadonlySet<string> {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) {
    return EMPTY_STRING_SET
  }
  return lookups.siblingToolUseIDs.get(toolUseID) ?? EMPTY_STRING_SET
}

/** 使用预计算查找表获取消息的进度消息。O(1)。 */
export function getProgressMessagesFromLookup(
  message: Message,
  lookups: MessageLookups,
): ProgressMessage[] {
  const toolUseID = getToolUseID(message)
  if (!toolUseID) {
    return []
  }
  return lookups.progressMessagesByToolUseID.get(toolUseID) ?? []
}

/** 使用预计算查找表检查未解决的 hook。O(1)。 */
export function hasUnresolvedHooksFromLookup(
  toolUseID: string,
  hookEvent: HookEvent,
  lookups: MessageLookups,
): boolean {
  const inProgressCount = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  const resolvedCount = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  return inProgressCount > resolvedCount
}

export function getToolUseIDs(normalizedMessages: Message[]): Set<string> {
  return new Set(
    normalizedMessages
      .filter(
        (_): _ is AssistantMessage =>
          _.type === 'assistant' && _.message.content[0]?.type === 'tool_call',
      )
      .map((_) => (_.message.content[0] as { id: string }).id),
  )
}
