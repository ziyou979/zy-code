/**
 * EXPERIMENT: Session memory compaction
 */

import type { UUID } from 'node:crypto'
import { getMainLoopModel } from '../model/model.js'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { createCompactBoundaryMessage, createUserMessage } from '../messages/constructors.js'
import { isCompactBoundaryMessage } from '../messages/predicates.js'
import { getSessionMemoryPath } from '../permissions/scratchpadStorage.js'
import { processSessionStartHooks } from '../session-storage/sessionStart.js'
import { tokenCountFromLastAPIResponse } from '../../services/api/tokens.js'
import { extractDiscoveredToolNames } from '../tool-runtime/toolSearch.js'
import {
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import { isSessionMemoryEmpty, truncateSessionMemoryForCompact } from '../session-memory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../session-memory/sessionMemoryUtils.js'
import { getTranscriptPath } from '../sessionStorage.js'
import {
  annotateBoundaryWithPreservedSegment,
  buildPostCompactMessages,
  type CompactionResult,
  createPlanAttachmentIfNeeded,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

/**
 * session memory 压缩阈值配置。
 */
export type SessionMemoryCompactConfig = {
  /** 压缩后至少保留的 token 数量。 */
  minTokens: number
  /** 至少保留多少条包含文本块的消息。 */
  minTextBlockMessages: number
  /** 压缩后最多保留的 token 数量（硬上限）。 */
  maxTokens: number
}

// 默认配置值，导出供测试使用。
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}

// 当前配置，初始采用默认值。
let smCompactConfig: SessionMemoryCompactConfig = {
  ...DEFAULT_SM_COMPACT_CONFIG,
}

// 记录是否已通过远程配置完成初始化。
let configInitialized = false

/**
 * 设置 session memory 压缩配置。
 */
export function setSessionMemoryCompactConfig(config: Partial<SessionMemoryCompactConfig>): void {
  smCompactConfig = {
    ...smCompactConfig,
    ...config,
  }
}

/**
 * 获取当前 session memory 压缩配置。
 */
export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...smCompactConfig }
}

/**
 * 重置配置状态，主要供测试使用。
 */
export function resetSessionMemoryCompactConfig(): void {
  smCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
  configInitialized = false
}

/**
 * 从远程配置（GrowthBook）初始化。
 * 每个会话只获取一次，后续调用会立即返回。
 */
async function initSessionMemoryCompactConfig(): Promise<void> {
  if (configInitialized) {
    return
  }
  configInitialized = true

  // 从 GrowthBook 加载配置，并与默认值合并。
  const remoteConfig = await getDynamicConfig_BLOCKS_ON_INIT<Partial<SessionMemoryCompactConfig>>(
    'zy_sm_compact_config',
    {},
  )

  // 仅采用显式设置为正数的远程值，避免零值覆盖合理的默认值。
  const config: SessionMemoryCompactConfig = {
    minTokens:
      remoteConfig.minTokens && remoteConfig.minTokens > 0
        ? remoteConfig.minTokens
        : DEFAULT_SM_COMPACT_CONFIG.minTokens,
    minTextBlockMessages:
      remoteConfig.minTextBlockMessages && remoteConfig.minTextBlockMessages > 0
        ? remoteConfig.minTextBlockMessages
        : DEFAULT_SM_COMPACT_CONFIG.minTextBlockMessages,
    maxTokens:
      remoteConfig.maxTokens && remoteConfig.maxTokens > 0
        ? remoteConfig.maxTokens
        : DEFAULT_SM_COMPACT_CONFIG.maxTokens,
  }
  setSessionMemoryCompactConfig(config)
}

/**
 * 检查消息是否包含文本块（用于 user/assistant 交互的文本内容）。
 */
export function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = Array.isArray(message.message.content) ? message.message.content : []
    return content.some((block) => block.type === 'text')
  }
  if (message.type === 'user') {
    const content = message.message.content
    return content.some((block) => block.type === 'text')
  }
  return false
}

/**
 * 检查消息中的 tool_result 块并返回对应的 tool_use_id。
 */
function getToolResultIds(message: Message): string[] {
  if (message.type !== 'user') {
    return []
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return []
  }
  const ids: string[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      ids.push(block.toolCallId)
    }
  }
  return ids
}

/**
 * 检查消息是否包含任一指定 id 对应的 tool_use 块。
 */
function hasToolUseWithIds(message: Message, toolUseIds: Set<string>): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => block.type === 'tool_call' && toolUseIds.has(block.id))
}

/**
 * 调整起始索引，确保不会拆开 tool_use/tool_result 对，也不会遗漏与保留的
 * assistant 消息共用同一 message.id 的 thinking 块。
 *
 * 只要任一保留消息包含 tool_result 块，就必须一并保留此前包含匹配
 * tool_use 块的 assistant 消息。
 *
 * 此外，只要保留范围内任一 assistant 消息与此前的 assistant 消息共用
 * message.id（后者可能包含 thinking 块），就必须一并保留此前消息，
 * 以便 normalizeMessagesForAPI 正确合并。
 *
 * 这用于处理流式输出将同一 message.id 下的各内容块（thinking、tool_use 等）
 * 拆成不同 uuid 消息的情况。若 startIndex 落在其中一条流式消息上，
 * 就需要检查所有保留消息中的 tool_result，而不能只检查第一条。
 *
 * 以下代码示例展示了所修复的问题：
 *
 * Tool pair scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ORPHAN_ID]
 *     Index N+2: assistant, message.id: X, content: [tool_use: VALID_ID]
 *     Index N+3: user, content: [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *
 *   If startIndex = N+2:
 *     - Old code: checked only message N+2 for tool_results, found none, returned N+2
 *     - After slicing and normalizeMessagesForAPI merging by message.id:
 *       msg[1]: assistant with [tool_use: VALID_ID]  (ORPHAN tool_use was excluded!)
 *       msg[2]: user with [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *     - API error: orphan tool_result references non-existent tool_use
 *
 * Thinking block scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ID]
 *     Index N+2: user, content: [tool_result: ID]
 *
 *   If startIndex = N+1:
 *     - Without this fix: thinking block at N is excluded
 *     - After normalizeMessagesForAPI: thinking block is lost (no message to merge with)
 *
 *   Fixed code: detects that message N+1 has same message.id as N, adjusts to N.
 */
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex
  }

  let adjustedIndex = startIndex

  // 第 1 步：处理 tool_use/tool_result 对。
  // 收集保留范围内所有消息的 tool_result ID。
  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    // 收集保留范围内已有的 tool_use ID。
    const toolUseIdsInKeptRange = new Set<string>()
    for (let i = adjustedIndex; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_call') {
            toolUseIdsInKeptRange.add(block.id)
          }
        }
      }
    }

    // 仅查找尚未包含在保留范围内的 tool_use。
    const neededToolUseIds = new Set(
      allToolResultIds.filter((id) => !toolUseIdsInKeptRange.has(id)),
    )

    // 查找包含匹配 tool_use 块的 assistant 消息。
    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      const message = messages[i]!
      if (hasToolUseWithIds(message, neededToolUseIds)) {
        adjustedIndex = i
        // 从集合中移除已找到的 tool_use_id。
        if (message.type === 'assistant' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'tool_call' && neededToolUseIds.has(block.id)) {
              neededToolUseIds.delete(block.id)
            }
          }
        }
      }
    }
  }

  // 第 2 步：处理与保留的 assistant 消息共用 message.id 的 thinking 块。
  // 收集保留范围内所有 assistant 消息的 message.id。
  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message.id) {
      messageIdsInKeptRange.add(msg.message.id)
    }
  }

  // 向前查找不在保留范围内、但具有相同 message.id 的 assistant 消息；
  // 这些消息可能含有需要由 normalizeMessagesForAPI 合并的 thinking 块。
  for (let i = adjustedIndex - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      message.message.id &&
      messageIdsInKeptRange.has(message.message.id)
    ) {
      // 此消息与保留范围内的消息共用 message.id，将其纳入以正确合并 thinking 块。
      adjustedIndex = i
    }
  }

  return adjustedIndex
}

/**
 * 计算压缩后保留消息的起始索引。
 * 从 lastSummarizedMessageId 开始向前扩展，直至达到以下下限：
 * - 至少保留 config.minTokens 个 token
 * - 至少保留 config.minTextBlockMessages 条包含文本块的消息
 * 达到 config.maxTokens 时停止扩展，同时确保不会拆开 tool_use/tool_result 对。
 */
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  if (messages.length === 0) {
    return 0
  }

  const config = getSessionMemoryCompactConfig()

  // 从 lastSummarizedIndex 的下一条消息开始。若其为 -1（未找到）或
  // messages.length（没有摘要 id），则初始不保留任何消息。
  let startIndex = lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length

  // 计算 startIndex 至末尾的 token 数和文本块消息数。
  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!
    totalTokens += estimateMessageTokens([msg])
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
  }

  // 检查是否已达到硬上限。
  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // 检查是否已同时满足两个下限。
  if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // 向前扩展，直至同时满足两个下限或达到硬上限。不得越过最后一个 boundary：
  // 保留片段链在该处存在磁盘断点（dedup-skip 产生的 att[0]→summary 捷径），
  // 否则 loader 从尾到头遍历时会跳过内部保留消息，随后将其裁剪。
  // Reactive compact 已通过 getHotContextMessages 在 boundary 处切分，
  // 此处遵循同一不变量。
  const idx = messages.findLastIndex((m) => isCompactBoundaryMessage(m))
  const floor = idx === -1 ? 0 : idx + 1
  for (let i = startIndex - 1; i >= floor; i--) {
    const msg = messages[i]!
    const msgTokens = estimateMessageTokens([msg])
    totalTokens += msgTokens
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
    startIndex = i

    // 达到硬上限时停止。
    if (totalTokens >= config.maxTokens) {
      break
    }

    // 同时满足两个下限时停止。
    if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) {
      break
    }
  }

  // 根据 tool 对调整边界。
  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}

/**
 * 检查是否应使用 session memory 进行压缩。
 * 使用缓存的 gate 值，避免等待 Statsig 初始化。
 */
export function shouldUseSessionMemoryCompaction(): boolean {
  // 允许 eval 运行和测试通过环境变量覆盖。
  if (isEnvTruthy(process.env.ENABLE_ZY_CODE_SM_COMPACT)) {
    return true
  }
  if (isEnvTruthy(process.env.DISABLE_ZY_CODE_SM_COMPACT)) {
    return false
  }

  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE('zy_session_memory', false)
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE('zy_sm_compact', false)
  const shouldUse = sessionMemoryFlag && smCompactFlag

  // 记录功能开关状态以便调试；仅限 ant，避免污染外部日志。
  if (isInternalBuild()) {
    logEvent('zy_sm_compact_flag_check', {
      zy_session_memory: sessionMemoryFlag,
      zy_sm_compact: smCompactFlag,
      should_use: shouldUse,
    })
  }

  return shouldUse
}

/**
 * 根据 session memory 创建 CompactionResult。
 */
function createCompactionResultFromSessionMemory(
  messages: Message[],
  sessionMemory: string,
  messagesToKeep: Message[],
  hookResults: Message[],
  transcriptPath: string,
  agentId?: AgentId,
): CompactionResult {
  const preCompactTokenCount = tokenCountFromLastAPIResponse(messages)

  const boundaryMarker = createCompactBoundaryMessage(
    'auto',
    preCompactTokenCount ?? 0,
    messages[messages.length - 1]?.uuid as UUID | undefined,
  )
  const preCompactDiscovered = extractDiscoveredToolNames(messages)
  if (preCompactDiscovered.size > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = [...preCompactDiscovered].sort()
  }

  // 截断过大的区段，避免 session memory 占满压缩后的 token 预算。
  const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(sessionMemory)

  let summaryContent = getCompactUserSummaryMessage(truncatedContent, true, transcriptPath, true)

  if (wasTruncated) {
    const memoryPath = getSessionMemoryPath()
    summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`
  }

  const summaryMessages = [
    createUserMessage({
      content: [{ type: 'text' as const, text: summaryContent }],
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  const planAttachment = createPlanAttachmentIfNeeded(agentId)
  const attachments = planAttachment ? [planAttachment] : []

  // SM-compact 不会调用 compact API，因此为保持事件连续性而保留的
  // postCompactTokenCount 与 truePostCompactTokenCount 最终取相同值。
  // 含 messagesToKeep：statusline 需要反映「摘要 + 保留尾部」的真实占用
  const truePostCompactTokenCount = estimateMessageTokens([
    ...summaryMessages,
    ...messagesToKeep,
    ...attachments,
  ])
  boundaryMarker.compactMetadata.postTokens = truePostCompactTokenCount

  return {
    boundaryMarker: annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      summaryMessages[summaryMessages.length - 1]!.uuid as UUID,
      messagesToKeep,
    ),
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
    preCompactTokenCount,
    postCompactTokenCount: truePostCompactTokenCount,
    truePostCompactTokenCount,
  }
}

/**
 * 尝试使用 session memory 代替传统压缩；无法使用时返回 null。
 *
 * 处理两种情况：
 * 1. 常规情况：已设置 lastSummarizedMessageId，仅保留该 ID 之后的消息
 * 2. 恢复的会话：未设置 lastSummarizedMessageId，但 session memory 有内容；
 *    保留全部消息，并将 session memory 用作摘要
 */
export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) {
    return null
  }

  // 从远程初始化配置，只获取一次。
  await initSessionMemoryCompactConfig()

  // 等待正在进行的 session memory 提取完成，并设有超时。
  await waitForSessionMemoryExtraction()

  const lastSummarizedMessageId = getLastSummarizedMessageId()
  const sessionMemory = await getSessionMemoryContent()

  // session memory 文件不存在。
  if (!sessionMemory) {
    logEvent('zy_sm_compact_no_session_memory', {})
    return null
  }

  // session memory 存在但仍与模板一致，说明尚未提取实际内容；
  // 退回旧版 compact 行为。
  if (await isSessionMemoryEmpty(sessionMemory)) {
    logEvent('zy_sm_compact_empty_template', {})
    return null
  }

  try {
    let lastSummarizedIndex: number

    if (lastSummarizedMessageId) {
      // 常规情况：可以准确确定哪些消息已纳入摘要。
      lastSummarizedIndex = messages.findIndex((msg) => msg.uuid === lastSummarizedMessageId)

      if (lastSummarizedIndex === -1) {
        // 当前消息中不存在摘要消息 ID，可能是消息已被修改。由于无法确定已摘要与
        // 未摘要消息的边界，退回旧版 compact。
        logEvent('zy_sm_compact_summarized_id_not_found', {})
        return null
      }
    } else {
      // 恢复的会话：session memory 有内容，但边界未知。将 lastSummarizedIndex
      // 指向最后一条消息，使 startIndex 等于 messages.length，初始不保留消息。
      lastSummarizedIndex = messages.length - 1
      logEvent('zy_sm_compact_resumed_session', {})
    }

    // 计算保留消息的起始索引：从 lastSummarizedIndex 开始扩展至满足下限，
    // 并调整边界以免拆开 tool_use/tool_result 对。
    const startIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
    // 从 messagesToKeep 中过滤旧 compact boundary。REPL 裁剪后，若再次产出
    // 保留消息中的旧 boundary，会触发意外的二次裁剪
    //（isCompactBoundaryMessage 返回 true），从而丢弃新 boundary 和摘要。
    const messagesToKeep = messages.slice(startIndex).filter((m) => !isCompactBoundaryMessage(m))

    // 运行 session start hook，以恢复 AGENTS.md 和其他上下文。
    const hookResults = await processSessionStartHooks('compact', {
      model: getMainLoopModel(),
    })

    // 获取摘要消息对应的 transcript 路径。
    const transcriptPath = getTranscriptPath()

    const compactionResult = createCompactionResultFromSessionMemory(
      messages,
      sessionMemory,
      messagesToKeep,
      hookResults,
      transcriptPath,
      agentId,
    )

    const postCompactMessages = buildPostCompactMessages(compactionResult)

    const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

    // 仅在提供阈值时检查，供 autocompact 使用。
    if (autoCompactThreshold !== undefined && postCompactTokenCount >= autoCompactThreshold) {
      logEvent('zy_sm_compact_threshold_exceeded', {
        postCompactTokenCount,
        autoCompactThreshold,
      })
      return null
    }

    // 同步 boundary.postTokens，与最终 postCompactMessages 估算一致
    if (
      compactionResult.boundaryMarker.type === 'system' &&
      compactionResult.boundaryMarker.subtype === 'compact_boundary'
    ) {
      compactionResult.boundaryMarker.compactMetadata.postTokens = postCompactTokenCount
    }

    return {
      ...compactionResult,
      postCompactTokenCount,
      truePostCompactTokenCount: postCompactTokenCount,
    }
  } catch (error) {
    // 此处的错误（如文件不存在、路径问题）属于预期情况，不应写入错误日志，
    // 因此使用 logEvent 而非 logError。
    logEvent('zy_sm_compact_error', {})
    if (isInternalBuild()) {
      logForDebugging(`Session memory compaction error: ${errorMessage(error)}`)
    }
    return null
  }
}
