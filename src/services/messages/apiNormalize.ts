// 从 api.ts 提取的 normalize / reorder / filter 实现。
// api.ts barrel 重新导出公开成员；私有 helpers 内部独占。

import last from 'lodash-es/last.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../api/errors.js'
import { type Tools, toolMatchesName } from '../../tool.js'
import type { ContentBlock, TextBlock, ToolResultBlock, UserContentBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { normalizeToolInputForAPI } from '../../utils/api.js'
import { logForDebugging } from '../../utils/debug.js'
import { validateImagesForAPI } from '../../utils/imageValidation.js'
import { normalizeLegacyToolName } from '../permissions/permissionRuleParser.js'
import { isToolReferenceBlock, isToolSearchEnabledOptimistic } from '../../utils/toolSearch.js'
import { normalizeAttachmentForAPI } from './api.js'
import { SYNTHETIC_MODEL } from './constants.js'
import { createUserMessage } from './constructors.js'
import {
  ensureNonEmptyAssistantContent,
  filterOrphanedThinkingOnlyMessages,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistantMessages,
  isToolResultMessage,
  mergeAdjacentUserMessages,
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
  smooshIntoToolResult,
} from './normalize.js'
import {
  isHookAttachmentMessage,
  isSystemLocalCommandMessage,
  isToolUseRequestMessage,
  type ToolUseRequestMessage,
} from './predicates.js'
import { stripToolReferenceBlocksFromUserMessage } from './prune.js'
import { wrapInSystemReminder } from './systemReminder.js'

// 延迟导入以避免循环依赖（teammateMailbox -> teammate -> ... -> messages）
export function getTeammateMailbox(): typeof import('../../utils/teammateMailbox.js') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../utils/teammateMailbox.js')
}

/** 将字符串包装为 UserContentBlock[] 文本块数组 */
export function textContent(text: string): UserContentBlock[] {
  return [{ type: 'text' as const, text }]
}

const TOOL_REFERENCE_TURN_BOUNDARY = 'Tool loaded.'

function isSyntheticApiErrorMessage(
  message: Message,
): message is AssistantMessage & { isApiErrorMessage: true } {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message.model === SYNTHETIC_MODEL
  )
}

// 拆分消息，使每个内容块获得自己的消息
// 重新排序，将结果消息移到工具使用消息之后
export function reorderMessagesInUI(
  messages: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[],
  syntheticStreamingToolUseMessages: AssistantMessage[],
): (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[] {
  // 将工具使用 ID 映射到其相关消息
  const toolUseGroups = new Map<
    string,
    {
      toolUse: ToolUseRequestMessage | null
      preHooks: AttachmentMessage[]
      toolResult: UserMessage | null
      postHooks: AttachmentMessage[]
    }
  >()

  // 第一遍：按工具使用 ID 分组消息
  for (const message of messages) {
    // 处理工具使用消息
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID) {
        if (!toolUseGroups.has(toolUseID)) {
          toolUseGroups.set(toolUseID, {
            toolUse: null,
            preHooks: [],
            toolResult: null,
            postHooks: [],
          })
        }
        toolUseGroups.get(toolUseID)!.toolUse = message
      }
      continue
    }

    // 处理工具使用前 hook
    if (isHookAttachmentMessage(message)) {
      const hookMsg = message as AttachmentMessage<Record<string, unknown>>
      if (hookMsg.attachment.hookEvent === 'PreToolUse') {
        const toolUseID = hookMsg.attachment.toolUseID as string
        if (!toolUseGroups.has(toolUseID)) {
          toolUseGroups.set(toolUseID, {
            toolUse: null,
            preHooks: [],
            toolResult: null,
            postHooks: [],
          })
        }
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        toolUseGroups.get(toolUseID)!.preHooks.push(hookMsg as any)
        continue
      }
    }

    // 处理工具结果
    if (message.type === 'user' && message.message.content[0]?.type === 'tool_result') {
      const toolUseID = message.message.content[0].toolCallId
      if (!toolUseGroups.has(toolUseID)) {
        toolUseGroups.set(toolUseID, {
          toolUse: null,
          preHooks: [],
          toolResult: null,
          postHooks: [],
        })
      }
      toolUseGroups.get(toolUseID)!.toolResult = message
      continue
    }

    // 处理工具使用后 hook
    if (isHookAttachmentMessage(message)) {
      const hookMsg = message as AttachmentMessage<Record<string, unknown>>
      if (hookMsg.attachment.hookEvent === 'PostToolUse') {
        const toolUseID = hookMsg.attachment.toolUseID as string
        if (!toolUseGroups.has(toolUseID)) {
          toolUseGroups.set(toolUseID, {
            toolUse: null,
            preHooks: [],
            toolResult: null,
            postHooks: [],
          })
        }
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        toolUseGroups.get(toolUseID)!.postHooks.push(hookMsg as any)
      }
    }
  }

  // 第二遍：以正确顺序重建消息列表
  const result: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[] = []
  const processedToolUses = new Set<string>()

  for (const message of messages) {
    // 检查是否为工具使用
    if (isToolUseRequestMessage(message)) {
      const toolUseID = message.message.content[0]?.id
      if (toolUseID && !processedToolUses.has(toolUseID)) {
        processedToolUses.add(toolUseID)
        const group = toolUseGroups.get(toolUseID)
        if (group?.toolUse) {
          // 按顺序输出：工具使用、前置 hook、工具结果、后置 hook
          result.push(group.toolUse)
          result.push(...group.preHooks)
          if (group.toolResult) {
            result.push(group.toolResult)
          }
          result.push(...group.postHooks)
        }
      }
      continue
    }

    // 检查此消息是否为工具使用组的一部分
    if (isHookAttachmentMessage(message)) {
      const hookMsg = message as AttachmentMessage<Record<string, unknown>>
      if (
        hookMsg.attachment.hookEvent === 'PreToolUse' ||
        hookMsg.attachment.hookEvent === 'PostToolUse'
      ) {
        // 跳过 — 已在工具使用组中处理
        continue
      }
    }

    if (message.type === 'user' && message.message.content[0]?.type === 'tool_result') {
      // 跳过 — 已在工具使用组中处理
      continue
    }

    // 处理 api 错误消息（仅保留最后一个）
    if (message.type === 'system' && message.subtype === 'api_error') {
      const last = result.at(-1)
      if (last?.type === 'system' && last.subtype === 'api_error') {
        result[result.length - 1] = message
      } else {
        result.push(message)
      }
      continue
    }

    // 添加独立消息
    result.push(message)
  }

  // 添加合成的流式工具使用消息
  for (const message of syntheticStreamingToolUseMessages) {
    result.push(message)
  }

  // 过滤以仅保留最后一个 api 错误消息
  const last = result.at(-1)
  return result.filter((_) => _.type !== 'system' || _.subtype !== 'api_error' || _ === last)
}

/**
 * 重新排序消息，使附件向上冒泡，直到遇到以下之一：
 * - 工具调用结果（带 tool_result 内容的用户消息）
 * - 任何 assistant 消息
 */
export function reorderAttachmentsForAPI(messages: Message[]): Message[] {
  // 我们反向构建 `result`（push），最后反转一次 — O(N)。
  // 在循环内使用 unshift 会是 O(N²)。
  const result: Message[] = []
  // 从下向上扫描时，附件被推入此缓冲区，因此
  // 它以相反顺序保存它们（相对于输入数组）。
  const pendingAttachments: AttachmentMessage[] = []

  // 从底部向上扫描
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!

    if (message.type === 'attachment') {
      // 收集要向上冒泡的附件
      pendingAttachments.push(message)
    } else {
      // 检查是否为停止点
      const isStoppingPoint =
        message.type === 'assistant' ||
        (message.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content[0]?.type === 'tool_result')

      if (isStoppingPoint && pendingAttachments.length > 0) {
        // 遇到停止点 — 附件在此停止（放在停止点之后）。
        // pendingAttachments 已反转；最终 result.reverse() 后
        // 它们会以原始顺序出现在 `message` 之后。
        for (let j = 0; j < pendingAttachments.length; j++) {
          result.push(pendingAttachments[j]!)
        }
        result.push(message)
        pendingAttachments.length = 0
      } else {
        // 普通消息
        result.push(message)
      }
    }
  }

  // 剩余附件一直冒泡到顶部。
  for (let j = 0; j < pendingAttachments.length; j++) {
    result.push(pendingAttachments[j]!)
  }

  result.reverse()
  return result
}

/**
 * 从 tool_result 内容中剥离不再存在的工具的 tool_reference 块。
 * 处理会话保存时使用的 MCP 工具不再可用的情况
 *（如 MCP 服务器已断开连接、重命名或移除）。
 * 不进行此过滤时，API 会拒绝并报错"在可用工具中找不到工具引用"。
 */
function stripUnavailableToolReferencesFromUserMessage(
  message: UserMessage,
  availableToolNames: Set<string>,
): UserMessage {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return message
  }

  // 检查是否有任何 tool_reference 块指向不可用的工具
  const hasUnavailableReference = content.some(
    (block) =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some((c) => {
        if (!isToolReferenceBlock(c)) {
          return false
        }
        const toolName = (c as { tool_name?: string }).tool_name
        return toolName && !availableToolNames.has(normalizeLegacyToolName(toolName))
      }),
  )

  if (!hasUnavailableReference) {
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

        // 过滤掉不可用工具的 tool_reference 块
        const filteredContent = block.content.filter((c) => {
          if (!isToolReferenceBlock(c)) {
            return true
          }
          const rawToolName = (c as { tool_name?: string }).tool_name
          if (!rawToolName) {
            return true
          }
          const toolName = normalizeLegacyToolName(rawToolName)
          const isAvailable = availableToolNames.has(toolName)
          if (!isAvailable) {
            logForDebugging(`Filtering out tool_reference for unavailable tool: ${toolName}`, {
              level: 'warn',
            })
          }
          return isAvailable
        })

        // 如果所有内容都被过滤掉了，用占位符替换
        if (filteredContent.length === 0) {
          return {
            ...block,
            content: [
              {
                type: 'text' as const,
                text: '[Tool references removed - tools no longer available]',
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

/**
 * content 数组是否包含 tool_result 块，其内部内容
 * 包含 tool_reference（ToolSearch 加载的工具）？
 */
function contentHasToolReference(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) =>
      block.type === 'tool_result' &&
      Array.isArray(block.content) &&
      block.content.some(isToolReferenceBlock),
  )
}

/**
 * 确保源自附件的消息中的所有文本内容都带有
 * <system-reminder> 包装。这使前缀成为后处理合并
 *（smooshSystemReminderSiblings）的可靠判别器 — 无需每个
 * normalizeAttachmentForAPI 分支都记得包装。
 *
 * 幂等：已包装的文本保持不变。
 */
function ensureSystemReminderWrap(msg: UserMessage): UserMessage {
  const content = msg.message.content
  let changed = false
  const newContent = content.map((b) => {
    if (b.type === 'text' && !b.text.startsWith('<system-reminder>')) {
      changed = true
      return { ...b, text: wrapInSystemReminder(b.text) }
    }
    return b
  })
  return changed ? { ...msg, message: { ...msg.message, content: newContent } } : msg
}

/**
 * 最后一步：将任何带有 `<system-reminder>` 前缀的文本同级合并到
 * 同一用户消息的最后一个 tool_result 中。捕获以下来源的同级：
 * - PreToolUse hook additionalContext（Gap F：assistant 和
 *   tool_result 之间的附件 → 独立推送 → mergeUserMessages → 提升 → 同级）
 * - relocateToolReferenceSiblings 输出（Gap E）
 * - 任何逃离合并时合并的源自附件的文本
 *
 * 非 system-reminder 文本（真实用户输入、TOOL_REFERENCE_TURN_BOUNDARY、
 * 上下文折叠 `<collapsed>` 摘要）保持 untouched — 实际用户输入前的
 * Human: 边界在语义上是正确的。A/B 测试（sai-20260310-161901，
 * Arm B）确认：真实用户输入保留为同级 + 2 个 SR 文本教师
 * 移除 → 0%。
 *
 * 幂等。形状的纯函数。
 */
export function smooshSystemReminderSiblings(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return messages.map((msg) => {
    if (msg.type !== 'user') {
      return msg
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      return msg
    }

    const hasToolResult = content.some((b) => b.type === 'tool_result')
    if (!hasToolResult) {
      return msg
    }

    const srText: TextBlock[] = []
    const kept: UserContentBlock[] = []
    for (const b of content) {
      if (b.type === 'text' && b.text.startsWith('<system-reminder>')) {
        srText.push(b)
      } else {
        kept.push(b)
      }
    }
    if (srText.length === 0) {
      return msg
    }

    // 合并到最后一个 tool_result（在渲染的 prompt 中位置相邻）
    const lastTrIdx = kept.findLastIndex((b) => b.type === 'tool_result')
    const lastTr = kept[lastTrIdx] as ToolResultBlock
    const smooshed = smooshIntoToolResult(lastTr, srText)
    // tool_ref 约束 — 保持不动
    if (smooshed === null) {
      return msg
    }

    const newContent = [...kept.slice(0, lastTrIdx), smooshed, ...kept.slice(lastTrIdx + 1)]
    return {
      ...msg,
      message: { ...msg.message, content: newContent },
    }
  })
}

/**
 * 从 is_error 的 tool_result 中剥离非文本块 — API 会拒绝该组合，
 * 报错 "all content must be type text if is_error is true"。
 *
 * 这是读取端防护，针对在 smooshIntoToolResult 学会按 is_error 过滤之前
 * 持久化的转录文件。没有此防护，恢复的会话每次调用都会收到 400 错误，
 * 且无法通过 /fork 恢复。被剥离图像留下的相邻文本会被重新合并。
 */
function sanitizeErrorToolResultContent(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return messages.map((msg) => {
    if (msg.type !== 'user') {
      return msg
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      return msg
    }

    let changed = false
    const newContent = content.map((b) => {
      if (b.type !== 'tool_result' || !b.isError) {
        return b
      }
      const trContent = b.content
      if (!Array.isArray(trContent)) {
        return b
      }
      if (trContent.every((c) => c.type === 'text')) {
        return b
      }
      changed = true
      const texts = trContent.filter((c) => c.type === 'text').map((c) => c.text)
      const textOnly: TextBlock[] =
        texts.length > 0 ? [{ type: 'text', text: texts.join('\n\n') }] : []
      return { ...b, content: textOnly }
    })
    if (!changed) {
      return msg
    }
    return { ...msg, message: { ...msg.message, content: newContent } }
  })
}

/**
 * 将文本块同级从包含 tool_reference 的用户消息中移走。
 *
 * 当 tool_result 包含 tool_reference 时，服务器会将其展开为 functions 块。
 * 追加到同一用户消息中的任何文本同级（auto-memory、skill 提醒等）会在
 * functions-close 标签之后创建第二个 human-turn 段 — 一种异常模式，
 * 模型会印记该模式。在后续的 tool-results 尾部，模型会补全该模式并
 * 发出停止序列。机制和五组剂量响应详见 #21049。
 *
 * 修复方案：找到下一个包含 tool_result 内容但不包含 tool_reference 的
 * 用户消息，将文本同级移动到那里。纯变换 — 无状态、无副作用。
 * 目标消息的现有同级（如有）保留；移动的块追加在后面。
 *
 * 如果不存在有效目标（tool_reference 消息在尾部附近），同级保持原位。
 * 这是安全的：以 human turn（带同级）结尾的尾部会在生成前获得 Assistant:
 * 提示；只有以裸工具输出（无同级）结尾的尾部才缺少该提示。
 *
 * 幂等：移动后，源消息没有文本同级；第二次遍历不会移动任何内容。
 */
function relocateToolReferenceSiblings(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const result = [...messages]

  for (let i = 0; i < result.length; i++) {
    const msg = result[i]!
    if (msg.type !== 'user') {
      continue
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      continue
    }
    if (!contentHasToolReference(content)) {
      continue
    }

    const textSiblings = content.filter((b) => b.type === 'text')
    if (textSiblings.length === 0) {
      continue
    }

    // 查找下一个有 tool_result 但没有 tool_reference 的用户消息。
    // 跳过包含 tool_reference 的目标 — 移过去只会
    // 在下一个位置重新创建问题。
    let targetIdx = -1
    for (let j = i + 1; j < result.length; j++) {
      const cand = result[j]!
      if (cand.type !== 'user') {
        continue
      }
      const cc = cand.message.content
      if (!Array.isArray(cc)) {
        continue
      }
      if (!cc.some((b) => b.type === 'tool_result')) {
        continue
      }
      if (contentHasToolReference(cc)) {
        continue
      }
      targetIdx = j
      break
    }

    if (targetIdx === -1) {
      continue // 无有效目标；保持原位。
    }

    // 从源消息剥离文本，追加到目标消息。
    result[i] = {
      ...msg,
      message: {
        ...msg.message,
        content: content.filter((b) => b.type !== 'text'),
      },
    }
    const target = result[targetIdx] as UserMessage
    result[targetIdx] = {
      ...target,
      message: {
        ...target.message,
        content: [...(target.message.content as UserContentBlock[]), ...textSiblings],
      },
    }
  }

  return result
}

export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tools = [],
): (UserMessage | AssistantMessage)[] {
  // 构建可用工具名称集合，用于过滤不可用的工具引用
  const availableToolNames = new Set(tools.map((t) => t.name))

  // 首先，重新排序附件使其向上冒泡，直到遇到工具结果或 assistant 消息
  // 然后剥离虚拟消息 — 它们仅用于显示（如 REPL 内部工具
  // 调用），绝不能发送到 API。
  const reorderedMessages = reorderAttachmentsForAPI(messages).filter(
    (m) => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
  )

  // 构建从错误文本到要从前一个用户消息中剥离的块类型的映射。
  const errorToBlockTypes: Record<string, Set<string>> = {
    [getPdfTooLargeErrorMessage()]: new Set(['document']),
    [getPdfPasswordProtectedErrorMessage()]: new Set(['document']),
    [getPdfInvalidErrorMessage()]: new Set(['document']),
    [getImageTooLargeErrorMessage()]: new Set(['image']),
    [getRequestTooLargeErrorMessage()]: new Set(['document', 'image']),
  }

  // 遍历重新排序的消息以构建针对性的剥离映射：
  // userMessageUUID → 要从该消息中剥离的块类型集合。
  const stripTargets = new Map<string, Set<string>>()
  for (let i = 0; i < reorderedMessages.length; i++) {
    const msg = reorderedMessages[i]!
    if (!isSyntheticApiErrorMessage(msg)) {
      continue
    }
    // 确定这是哪种错误
    const errorText =
      Array.isArray(msg.message.content) && msg.message.content[0]?.type === 'text'
        ? msg.message.content[0].text
        : undefined
    if (!errorText) {
      continue
    }
    const blockTypesToStrip = errorToBlockTypes[errorText]
    if (!blockTypesToStrip) {
      continue
    }
    // 向后查找最近的 isMeta 用户消息
    for (let j = i - 1; j >= 0; j--) {
      const candidate = reorderedMessages[j]!
      if (candidate.type === 'user' && candidate.isMeta) {
        const existing = stripTargets.get(candidate.uuid)
        if (existing) {
          for (const t of blockTypesToStrip) {
            existing.add(t)
          }
        } else {
          stripTargets.set(candidate.uuid, new Set(blockTypesToStrip))
        }
        break
      }
      // 跳过其他合成错误消息或非 meta 消息
      if (isSyntheticApiErrorMessage(candidate)) {
        continue
      }
      // 遇到 assistant 消息或非 meta 用户消息时停止
      break
    }
  }

  const result: (UserMessage | AssistantMessage)[] = []
  reorderedMessages
    .filter(
      (_): _ is UserMessage | AssistantMessage | AttachmentMessage | SystemLocalCommandMessage => {
        if (
          _.type === 'progress' ||
          (_.type === 'system' && !isSystemLocalCommandMessage(_)) ||
          isSyntheticApiErrorMessage(_)
        ) {
          return false
        }
        return true
      },
    )
    .forEach((message) => {
      switch (message.type) {
        case 'system': {
          // local_command 系统消息需要作为用户消息包含
          // 以便模型能在后续轮次中引用之前的命令输出
          const userMsg = createUserMessage({
            content: [{ type: 'text' as const, text: message.content }],
            uuid: message.uuid,
            timestamp: message.timestamp,
          })
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(lastMessage, userMsg)
            return
          }
          result.push(userMsg)
          return
        }
        case 'user': {
          // 合并连续的用户消息，因为 Bedrock 不支持
          // 连续多条用户消息；直接 API 支持并将其合并为
          // 单个用户轮次

          // 工具搜索未启用时，从 tool_result 内容中剥离所有 tool_reference 块，
          // 因为这些仅在工具搜索 beta 中有效。
          // 工具搜索启用时，仅剥离不再存在的工具的 tool_reference 块
          //（如 MCP 服务器已断开连接）。
          let normalizedMessage = message
          if (!isToolSearchEnabledOptimistic()) {
            normalizedMessage = stripToolReferenceBlocksFromUserMessage(message)
          } else {
            normalizedMessage = stripUnavailableToolReferencesFromUserMessage(
              message,
              availableToolNames,
            )
          }

          // 从导致 PDF/图像/请求过大错误的特定 meta 用户消息中
          // 剥离 document/image 块，防止在后续每个 API 调用中
          // 重新发送有问题的内容。
          const typesToStrip = stripTargets.get(normalizedMessage.uuid)
          if (typesToStrip && normalizedMessage.isMeta) {
            const content = normalizedMessage.message.content
            if (Array.isArray(content)) {
              const filtered = content.filter((block) => !typesToStrip.has(block.type))
              if (filtered.length === 0) {
                // 所有内容块都被剥离了；完全跳过此消息
                return
              }
              if (filtered.length < content.length) {
                normalizedMessage = {
                  ...normalizedMessage,
                  message: {
                    ...normalizedMessage.message,
                    content: filtered,
                  },
                }
              }
            }
          }

          // 服务端将 tool_reference 扩展渲染为 <functions>...</functions>
          //（与系统提示的工具块相同的标签）。当这在 prompt
          // 末尾时，capybara 模型以 ~10% 采样停止序列（A/B：
          // 21/200 vs 0/200 on v3-prod）。同级文本块插入干净的
          // "\n\nHuman: ..." 轮次边界。在此注入（API 准备）而不是
          // 存储在消息中，这样它永远不会在 REPL 中渲染，并且当
          // 上方 strip* 移除所有 tool_reference 内容时自动跳过。
          // 必须是同级，不能在 tool_result.content 内 — 在块内
          // 混合文本与 tool_reference 会导致服务端 ValueError。
          // 幂等：query.ts 每个 tool-result 调用此函数；输出通过
          // zy.ts 在下一次 API 请求时流经此处。第一遍的同级
          // 会从下方的 appendMessageTag 获得 \n[id:xxx] 后缀，
          // 因此 startsWith 匹配裸格式和带标签格式。
          //
          // 当 zy_toolref_defer_j8m 激活时关闭 — 该 gate
          // 启用下方的 relocateToolReferenceSiblings 进行后处理，
          // 它将现有同级移动到后面的非引用消息而不是
          // 在此添加一个。此注入本身会被 relocated，
          // 因此跳过它可以节省一次扫描。gate 关闭时，
          // 这是回退方案（与 pre-#21049 main 相同）。
          if (!checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_toolref_defer_j8m')) {
            const contentAfterStrip = normalizedMessage.message.content
            if (
              Array.isArray(contentAfterStrip) &&
              !contentAfterStrip.some(
                (b) => b.type === 'text' && b.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY),
              ) &&
              contentHasToolReference(contentAfterStrip)
            ) {
              normalizedMessage = {
                ...normalizedMessage,
                message: {
                  ...normalizedMessage.message,
                  content: [
                    ...contentAfterStrip,
                    { type: 'text', text: TOOL_REFERENCE_TURN_BOUNDARY },
                  ],
                },
              }
            }
          }

          // 如果最后一条消息也是用户消息，合并它们
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = mergeUserMessages(lastMessage, normalizedMessage)
            return
          }

          // 否则，正常添加消息
          result.push(normalizedMessage)
          return
        }
        case 'assistant': {
          // 为 API 标准化工具输入（从 ExitPlanModeV2 等中剥离 plan 等字段）
          // 工具搜索未启用时，必须从 tool_use 块中剥离 tool_search 特有字段
          // 如 'caller'，因为这些仅在工具搜索 beta header 下有效
          const toolSearchEnabled = isToolSearchEnabledOptimistic()
          const normalizedMessage: AssistantMessage = {
            ...message,
            message: {
              ...message.message,
              content: Array.isArray(message.message.content)
                ? message.message.content.map((block) => {
                    if (block.type === 'tool_call') {
                      const tool = tools.find((t) => toolMatchesName(t, block.name))
                      const normalizedInput = tool
                        ? normalizeToolInputForAPI(tool, block.input as Record<string, unknown>)
                        : block.input
                      const canonicalName = tool?.name ?? block.name

                      // 工具搜索启用时，保留所有字段包括 'caller'
                      if (toolSearchEnabled) {
                        return {
                          ...block,
                          name: canonicalName,
                          input: normalizedInput,
                        }
                      }

                      // 工具搜索未启用时，显式构造仅含标准 API 字段的 tool_use
                      // 块，避免发送 'caller' 等字段（这些可能来自工具搜索运行的会话存储）
                      return {
                        type: 'tool_call' as const,
                        id: block.id,
                        name: canonicalName,
                        input: normalizedInput,
                      }
                    }
                    return block
                  })
                : message.message.content,
            },
          }

          // 查找具有相同消息 ID 的前一个 assistant 消息并合并。
          // 向后遍历，跳过工具结果和不同 ID 的 assistant，
          // 因为并发代理（teammates）可能交错来自多个 API 响应的
          // 具有不同消息 ID 的流式内容块。
          for (let i = result.length - 1; i >= 0; i--) {
            const msg = result[i]!

            if (msg.type !== 'assistant' && !isToolResultMessage(msg)) {
              break
            }

            if (msg.type === 'assistant') {
              if (msg.message.id === normalizedMessage.message.id) {
                result[i] = mergeAssistantMessages(msg, normalizedMessage)
                return
              }
            }
          }

          result.push(normalizedMessage)
          return
        }
        case 'attachment': {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
          const rawAttachmentMessage = normalizeAttachmentForAPI(message.attachment as any)
          const attachmentMessage = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_chair_sermon')
            ? rawAttachmentMessage.map(ensureSystemReminderWrap)
            : rawAttachmentMessage

          // 如果最后一条消息也是用户消息，合并它们
          const lastMessage = last(result)
          if (lastMessage?.type === 'user') {
            result[result.length - 1] = attachmentMessage.reduce(
              (p, c) => mergeUserMessagesAndToolResults(p, c),
              lastMessage,
            )
            return
          }

          result.push(...attachmentMessage)
          return
        }
      }
    })

  // 将 tool_reference 消息的文本同级重新定位 — 防止
  // 异常的两个连续人工轮次模式，这会让模型
  // 在工具结果后发出停止序列。见 #21049。
  // 在合并之后（同级就位）和 ID 标记之前运行（因此
  // 标记反映最终位置）。gate 关闭时，这是空操作，
  // 上方的 TOOL_REFERENCE_TURN_BOUNDARY 注入作为回退。
  const relocated = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_toolref_defer_j8m')
    ? relocateToolReferenceSiblings(result)
    : result

  // 过滤孤立的纯 thinking assistant 消息（可能由 compact 在失败的流式响应
  // 与其重试之间切掉中间消息而引入）。不这样做的话，带有不匹配 thinking 块
  // 签名的连续 assistant 消息会导致 API 400 错误。
  const withFilteredOrphans = filterOrphanedThinkingOnlyMessages(relocated)

  // 顺序很重要：先剥离尾部 thinking，再过滤纯空白消息。
  // 反向顺序有一个 bug：像 [text("\n\n"), thinking("...")] 这样的消息
  // 能通过空白过滤（因为有非文本块），然后 thinking 剥离会移除 thinking 块，
  // 剩下 [text("\n\n")] — API 会拒绝。
  //
  // 这些多轮归一化本质上很脆弱 — 每轮都可能创建前一轮要处理的条件。
  // 考虑统一为单轮清理内容，然后一次性验证。
  const withFilteredThinking = filterTrailingThinkingFromLastAssistant(withFilteredOrphans)
  const withFilteredWhitespace = filterWhitespaceOnlyAssistantMessages(withFilteredThinking)
  const withNonEmpty = ensureNonEmptyAssistantContent(withFilteredWhitespace)

  // filterOrphanedThinkingOnlyMessages 不会合并相邻的 user 消息（空白过滤器会，
  // 但仅当它触发时）。在此合并，这样 smoosh 可以折叠 hoistToolResults 产生的
  // SR-text 兄弟节点。smoosh 本身会将 <system-reminder> 前缀的 text 兄弟节点
  // 折叠到相邻的 tool_result 中。
  // 一起门控：合并存在的唯一目的是供给 smoosh；非门控运行会改变 @-mention 场景
  // （相邻 [prompt, attachment] user）的 VCR fixture 哈希，而当 smoosh 关闭时
  // 没有任何好处。
  const smooshed = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_chair_sermon')
    ? smooshSystemReminderSiblings(mergeAdjacentUserMessages(withNonEmpty))
    : withNonEmpty

  // 无条件执行 — 捕获 smooshIntoToolResult 学会根据 is_error 过滤之前持久化的记录。
  // 不这样做的话，恢复的会话中带有 image-in-error tool_result 会无限 400。
  const sanitized = sanitizeErrorToolResultContent(smooshed)

  // 发送前验证所有图片是否在 API 大小限制内
  validateImagesForAPI(sanitized)

  return sanitized
}

// 有时 API 会返回空消息（例如 "\n\n"）。我们需要过滤掉它们，
// 否则下次调用 query() 发送到 API 时会产生 API 错误。
export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  // 直接从消息内容块收集所有 tool_use ID 和 tool_result ID。
  // 这避免了调用 normalizeMessages()（它会生成新 UUID） — 如果那些
  // 归一化后的消息被返回并稍后记录到 transcript JSONL 中，
  // UUID 去重将无法捕获它们，导致每次会话恢复时 transcript 指数增长。
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') {
      continue
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (block.type === 'tool_call') {
        toolUseIds.add(block.id)
      }
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolCallId)
      }
    }
  }

  const unresolvedIds = new Set([...toolUseIds].filter((id) => !toolResultIds.has(id)))

  if (unresolvedIds.size === 0) {
    return messages
  }

  // 过滤掉 tool_use 块全部未解决的 assistant 消息
  return messages.filter((msg) => {
    if (msg.type !== 'assistant') {
      return true
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      return true
    }
    const toolUseBlockIds: string[] = []
    for (const b of content) {
      if (b.type === 'tool_call') {
        toolUseBlockIds.push(b.id)
      }
    }
    if (toolUseBlockIds.length === 0) {
      return true
    }
    // 仅当消息的所有 tool_use 块都未解决时才移除
    return !toolUseBlockIds.every((id) => unresolvedIds.has(id))
  })
}
