import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const sessionTranscriptModule = feature('KAIROS')
  ? (require('../sessionTranscript/sessionTranscript.js') as typeof import('../sessionTranscript/sessionTranscript.js'))
  : null

import { createAbortError } from '../../types/llm.js'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import {
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
} from '../../tools/FileReadTool/prompt.js'
import { ToolSearchTool } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  HookResultMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import {
  createAttachmentMessage,
  generateFileAttachment,
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from '../../utils/attachments.js'
import { getMemoryPath } from '../../utils/config.js'
import { COMPACT_MAX_OUTPUT_TOKENS } from '../../utils/context.js'
import {
  analyzeContext,
  tokenStatsToStatsigMetrics,
} from '../../utils/contextAnalysis.js'
import { logForDebugging } from '../../utils/debug.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { cacheToObject } from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  executePostCompactHooks,
  executePreCompactHooks,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { MEMORY_TYPE_VALUES } from '../../utils/memory/types.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  getAssistantMessageText,
  getLastAssistantMessage,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import {
  isSessionActivityTrackingActive,
  sendSessionActivitySignal,
} from '../../utils/sessionActivity.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  getTranscriptPath,
  reAppendSessionMetadata,
} from '../../utils/sessionStorage.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  getTokenUsage,
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  getMaxOutputTokensForModel,
  queryModelWithStreaming,
} from '../api/zy.js'
import {
  getPromptTooLongTokenGap,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
} from '../api/errors.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { getRetryDelay } from '../api/withRetry.js'
import { logPermissionContextForAnts } from '../internalLogging.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../tokenEstimation.js'
import { groupMessagesByApiRound } from './grouping.js'
import {
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
} from './prompt.js'

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
// Skills 可能较大（verify=18.7KB, zy-api=20.1KB）。之前每次 compact 时无限制重新注入
// → 每次 compact 消耗 5-10K token。按 skill 截断比直接丢弃更好 — skill 文件顶部的
// 指令通常是最关键的部分。预算大小足以容纳约 5 个 skill，每个不超过 per-skill 上限。
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
const MAX_COMPACT_STREAMING_RETRIES = 2

/**
 * 在发送压缩请求前，从 user 消息中移除图片块。
 * 生成对话摘要不需要图片，而且图片可能导致压缩 API 调用本身触及 prompt-too-long 限制，
 * 尤其在 CCD 会话中用户频繁附加图片的场景。
 * 用文本标记替换图片块，这样摘要仍会注明有图片被分享过。
 *
 * 注意：只有 user 消息包含图片（直接附加或在工具的 tool_result 内容中）。
 * assistant 消息包含文本、tool_use 和 thinking 块，但不包含图片。
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') {
      return message
    }

    const content = message.message.content
    if (!Array.isArray(content)) {
      return message
    }

    let hasMediaBlock = false
    const newContent = content.flatMap(block => {
      if (block.type === 'image') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[image]' }]
      }
      if (block.type === 'document') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[document]' }]
      }
      // Also strip images/documents nested inside tool_result content arrays
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        let toolHasMedia = false
        const newToolContent = block.content.map(item => {
          if (item.type === 'image') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[image]' }
          }
          if ((item.type as any) === 'document') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[document]' }
          }
          return item
        })
        if (toolHasMedia) {
          hasMediaBlock = true
          return [{ ...block, content: newToolContent }]
        }
      }
      return [block]
    })

    if (!hasMediaBlock) {
      return message
    }

    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    } as typeof message
  })
}

/**
 * 移除那些在压缩后会被重新注入的附件类型。
 * skill_discovery/skill_listing 会通过 resetSentSkillNames() 和下一次发现的
 * 信号重新出现，所以把它们传给摘要生成器会浪费 token，还会用过时的 skill
 * 建议污染摘要。
 *
 * 当 EXPERIMENTAL_SKILL_SEARCH 关闭时无操作（外部构建中这些附件类型不存在）。
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    return messages.filter(
      m =>
        !(
          m.type === 'attachment' &&
          (m.attachment.type === 'skill_discovery' ||
            m.attachment.type === 'skill_listing')
        ),
    )
  }
  return messages
}

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES =
  'Not enough messages to compact.'
const MAX_PTL_RETRIES = 3
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

/**
 * 从消息中丢弃最旧的 API-round 分组，直到覆盖 tokenGap。
 * 当 gap 无法解析时（某些 Vertex/Bedrock 错误格式），回退到丢弃 20% 的分组。
 * 如果不留下任何可摘要的内容就无法再丢弃时，返回 null。
 *
 * 这是 CC-1180 的最后手段 — 当压缩请求本身触发 prompt-too-long 时，
 * 用户否则会被卡住。丢弃最旧的上下文是有损的，但能让用户继续操作。
 * reactive-compact 路径（compactMessages.ts）有正确的重试循环，从尾部剥离；
 * 这个辅助函数是 proactive/manual 路径中简单但安全的回退方案，
 * 在 bfdb472f 的统一迁移中未被迁移。
 */
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  // 在分组前，先移除之前重试时我们自己添加的合成标记。
  // 否则它会变成自己的 group 0，导致 20% 回退机制卡住
  //（只丢弃标记，又重新添加，重试 2+ 次零进展）。
  const input =
    messages[0]?.type === 'user' &&
    messages[0].isMeta &&
    messages[0].message.content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages

  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g as any)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  // 至少保留一个分组，这样还有内容可摘要。
  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount < 1) return null

  const sliced = groups.slice(dropCount).flat()
  // groupMessagesByApiRound 将 preamble 放在 group 0，且每个后续分组都以
  // assistant 消息开头。丢弃 group 0 后会留下 assistant 开头的序列，
  // API 会拒绝（第一条消息必须是 role=user）。添加一个合成的 user 标记 —
  // ensureToolResultPairing 已经处理由此产生的孤立 tool_result。
  if (sliced[0]?.type === 'assistant') {
    return [
      createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
      ...sliced,
    ]
  }
  return sliced
}

export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'Conversation too long. Press esc twice to go up a few messages and try again.'
export const ERROR_MESSAGE_USER_ABORT = 'API Error: Request was aborted.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction interrupted · This may be due to network issues — please try again.'

export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  compactionUsage?: ReturnType<typeof getTokenUsage>
}

/**
 * 从 autoCompactIfNeeded 传递给 compactConversation 的诊断上下文。
 * 让 tengu_compact 事件能够在不 join 的情况下区分同链循环（H2）、
 * 跨 agent（H1/H5）以及手动与自动（H3）压缩。
 */
export type RecompactionInfo = {
  isRecompactionInChain: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: QuerySource
}

/**
 * 从 CompactionResult 构建基础的压缩后消息数组。
 * 确保所有压缩路径下的一致性排序。
 * 顺序：boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults
 */
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

/**
 * 为 messagesToKeep 用重连元数据标注压缩边界。
 * 保留的消息在磁盘上保留其原始 parentUuids（去重跳过的）；
 * 加载器用它来修补 head→anchor 和 anchor 的其他子节点→tail。
 *
 * `anchorUuid` = 在期望链中位于 keep[0] 之前的内容：
 *   - 后缀保留（reactive/session-memory）：最后一条摘要消息
 *   - 前缀保留（partial compact）：边界本身
 */
export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: readonly Message[] | undefined,
): SystemCompactBoundaryMessage {
  const keep = messagesToKeep ?? []
  if (keep.length === 0) return boundary
  return {
    ...boundary,
    compactMetadata: {
      ...boundary.compactMetadata,
      preservedSegment: {
        headUuid: keep[0]!.uuid,
        anchorUuid,
        tailUuid: keep.at(-1)!.uuid,
      },
    },
  }
}

/**
 * 合并用户提供的自定义指令和 hook 提供的指令。
 * 用户指令在前，hook 指令在后。
 * 空字符串统一归一化为 undefined。
 */
export function mergeHookInstructions(
  userInstructions: string | undefined,
  hookInstructions: string | undefined,
): string | undefined {
  if (!hookInstructions) return userInstructions || undefined
  if (!userInstructions) return hookInstructions
  return `${userInstructions}\n\n${hookInstructions}`
}

/**
 * 创建对话的压缩版本，通过摘要旧消息并保留最近的对话历史。
 */
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  try {
    if (messages.length === 0) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    }

    const preCompactTokenCount = tokenCountWithEstimation(messages)

    const appState = context.getAppState()
    void logPermissionContextForAnts(appState.toolPermissionContext, 'summary')

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'pre_compact',
    })

    // 执行 PreCompact hooks
    context.setSDKStatus?.('compacting')
    const hookResult = await executePreCompactHooks(
      {
        trigger: isAutoCompact ? 'auto' : 'manual',
        customInstructions: customInstructions ?? null,
      },
      context.abortController.signal,
    )
    customInstructions = mergeHookInstructions(
      customInstructions,
      hookResult.newCustomInstructions,
    )
    const userDisplayMessage = hookResult.userDisplayMessage

    // 显示请求模式，带上箭头和自定义消息
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    // 第三方默认：true — forked-agent 路径复用主对话的 prompt cache。
    // 实验（2026年1月）确认：false 路径 98% cache miss，消耗约 0.76% 的
    // 集群 cache_creation（约 38B token/天），集中在临时环境（CCR/GHA/SDK），
    // 这些环境中 GB cache 是冷的，且 GB 被禁用的第三方提供商。GB gate 作为 kill-switch 保留。
    const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_compact_cache_prefix',
      true,
    )

    const compactPrompt = getCompactPrompt(customInstructions)
    const summaryRequest = createUserMessage({
      content: compactPrompt,
    })

    let messagesToSummarize = messages
    let retryCacheSafeParams = cacheSafeParams
    let summaryResponse: AssistantMessage
    let summary: string | null
    let ptlAttempts = 0
    for (;;) {
      summaryResponse = await streamCompactSummary({
        messages: messagesToSummarize,
        summaryRequest,
        appState,
        context,
        preCompactTokenCount,
        cacheSafeParams: retryCacheSafeParams,
      })
      summary = getAssistantMessageText(summaryResponse)
      if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

      // CC-1180：压缩请求本身触发了 prompt-too-long。截断最旧的
      // API-round 分组并重试，而不是让用户卡住。
      ptlAttempts++
      const truncated =
        ptlAttempts <= MAX_PTL_RETRIES
          ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
          : null
      if (!truncated) {
        logEvent('tengu_compact_failed', {
          reason:
            'prompt_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
          promptCacheSharingEnabled,
          ptlAttempts,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      logEvent('tengu_compact_ptl_retry', {
        attempt: ptlAttempts,
        droppedMessages: messagesToSummarize.length - truncated.length,
        remainingMessages: truncated.length,
      })
      messagesToSummarize = truncated
      // forked-agent 路径从 cacheSafeParams.forkContextMessages 读取，
      // 而不是 messages 参数 — 将截断后的集合传递到两条路径中。
      retryCacheSafeParams = {
        ...retryCacheSafeParams,
        forkContextMessages: truncated,
      }
    }

    if (!summary) {
      logForDebugging(
        `Compact failed: no summary text in response. Response: ${jsonStringify(summaryResponse)}`,
        { level: 'error' },
      )
      logEvent('tengu_compact_failed', {
        reason:
          'no_summary' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        promptCacheSharingEnabled,
      })
      throw new Error(
        `Failed to generate conversation summary - response did not contain valid text content`,
      )
    } else if (startsWithApiErrorPrefix(summary)) {
      logEvent('tengu_compact_failed', {
        reason:
          'api_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        promptCacheSharingEnabled,
      })
      throw new Error(summary)
    }

    // 清除前保存当前文件状态
    const preCompactReadFileState = cacheToObject(context.readFileState)

    // 清除缓存
    context.readFileState.clear()
    context.loadedNestedMemoryPaths?.clear()

    // 有意不重置 sentSkillNames：压缩后重新注入完整的
    // skill_listing（约 4K token）纯属 cache_creation，收益甚微。
    // 模型的 schema 中仍有 SkillTool，且 invoked_skills 附件（如下）
    // 保留了已用 skill 的内容。启用了 EXPERIMENTAL_SKILL_SEARCH 的
    // Ants 已经通过 getSkillListingAttachments 中的 early-return 跳过重新注入。

    // 并行执行异步附件生成
    const [fileAttachments, asyncAgentAttachments] = await Promise.all([
      createPostCompactFileAttachments(
        preCompactReadFileState,
        context,
        POST_COMPACT_MAX_FILES_TO_RESTORE,
      ),
      createAsyncAgentAttachmentsIfNeeded(context),
    ])

    const postCompactFileAttachments: AttachmentMessage[] = [
      ...fileAttachments,
      ...asyncAgentAttachments,
    ]
    const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
    if (planAttachment) {
      postCompactFileAttachments.push(planAttachment)
    }

    // 如果当前处于 plan 模式，添加 plan mode 指令，这样模型在压缩后仍保持 plan 模式
    const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
    if (planModeAttachment) {
      postCompactFileAttachments.push(planModeAttachment)
    }

    // 添加 skill 附件，如果本次会话中调用了 skills
    const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
    if (skillAttachment) {
      postCompactFileAttachments.push(skillAttachment)
    }

    // 压缩消耗了之前的增量附件。从当前状态重新声明，
    // 这样模型在压缩后的第一轮就有工具/指令上下文。
    // 空消息历史 → 与无内容对比 → 声明完整集合。
    for (const att of getDeferredToolsDeltaAttachment(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      { callSite: 'compact_full' },
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getAgentListingDeltaAttachment(context, [])) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getMcpInstructionsDeltaAttachment(
      context.options.mcpClients,
      context.options.tools,
      context.options.mainLoopModel,
      [],
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'session_start',
    })
    // 压缩成功后执行 SessionStart hooks
    const hookMessages = await processSessionStartHooks('compact', {
      model: context.options.mainLoopModel,
    })

    // 在事件之前创建压缩边界标记和摘要消息，
    // 这样我们可以计算真实的压缩后上下文大小。
    const boundaryMarker = createCompactBoundaryMessage(
      isAutoCompact ? 'auto' : 'manual',
      preCompactTokenCount ?? 0,
      (messages.at(-1)?.uuid as any),
    )
    // 携带已加载工具的状态 — 摘要不保留 tool_reference 块，
    // 所以压缩后的 schema 过滤器需要这个信息来继续向 API
    // 发送已加载的 deferred tool schema。
    const preCompactDiscovered = extractDiscoveredToolNames(messages)
    if (preCompactDiscovered.size > 0) {
      (boundaryMarker.compactMetadata as any).preCompactDiscoveredTools = [
        ...preCompactDiscovered,
      ].sort()
    }

    const transcriptPath = getTranscriptPath()
    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summary,
          suppressFollowUpQuestions,
          transcriptPath,
        ),
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]

    // 之前叫 "postCompactTokenCount" — 改名因为这个是压缩 API 调用的
    // 总用量（input_tokens ≈ preCompactTokenCount），而不是压缩后上下文的大小。
    // 保留是为了事件字段的连续性。
    const compactionCallTotalTokens = tokenCountFromLastAPIResponse([
      summaryResponse,
    ])

    // 对压缩后上下文的消息载荷估算。下一次迭代的 shouldAutoCompact
    // 会看到这个值再加上约 20-40K 的 system prompt + tools + userContext
    //（通过 API usage.input_tokens）。所以 `willRetriggerNextTurn: true`
    // 是强信号；`false` 在接近阈值时仍可能重新触发。
    const truePostCompactTokenCount = roughTokenCountEstimationForMessages([
      boundaryMarker,
      ...summaryMessages,
      ...postCompactFileAttachments,
      ...hookMessages,
    ] as any)

    // 提取压缩 API 用量指标
    const compactionUsage = getTokenUsage(summaryResponse)

    const querySourceForEvent =
      recompactionInfo?.querySource ?? context.options.querySource ?? 'unknown'

    logEvent('tengu_compact', {
      preCompactTokenCount,
      // 保留以维持连续性 — 语义上是压缩 API 调用的总用量
      postCompactTokenCount: compactionCallTotalTokens,
      truePostCompactTokenCount,
      autoCompactThreshold: recompactionInfo?.autoCompactThreshold ?? -1,
      willRetriggerNextTurn:
        recompactionInfo !== undefined &&
        truePostCompactTokenCount >= recompactionInfo.autoCompactThreshold,
      isAutoCompact,
      querySource:
        querySourceForEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryChainId: (context.queryTracking?.chainId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: context.queryTracking?.depth ?? -1,
      isRecompactionInChain: recompactionInfo?.isRecompactionInChain ?? false,
      turnsSincePreviousCompact:
        recompactionInfo?.turnsSincePreviousCompact ?? -1,
      previousCompactTurnId: (recompactionInfo?.previousCompactTurnId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      compactionInputTokens: compactionUsage?.input_tokens,
      compactionOutputTokens: compactionUsage?.output_tokens,
      compactionCacheReadTokens: compactionUsage?.cache_read_input_tokens ?? 0,
      compactionCacheCreationTokens:
        compactionUsage?.cache_creation_input_tokens ?? 0,
      compactionTotalTokens: compactionUsage
        ? compactionUsage.input_tokens +
          (compactionUsage.cache_creation_input_tokens ?? 0) +
          (compactionUsage.cache_read_input_tokens ?? 0) +
          compactionUsage.output_tokens
        : 0,
      promptCacheSharingEnabled,
      // analyzeContext 遍历每个内容块（4.5K 消息的会话约 11ms），
      // 纯粹用于这个遥测分解。在压缩 API await 之后计算，
      // 这样同步遍历不会在压缩开始前饿死渲染循环。
      // 与 reactiveCompact.ts 使用相同的延迟模式。
      ...(() => {
        try {
          return tokenStatsToStatsigMetrics(analyzeContext(messages))
        } catch (error) {
          logError(error as Error)
          return {}
        }
      })(),
    })

    // 重置 cache 读取基线，这样压缩后的 drop 不会被标记为 break
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(
        (context.options.querySource ?? 'compact') as any,
        context.agentId,
      )
    }
    markPostCompaction()

    // 重新附加 session 元数据（自定义标题、标签），使其保持在
    // readLiteMetadata 读取的 16KB 尾部窗口内，供 --resume 显示使用。
    // 否则，压缩后的消息会将元数据条目推出窗口，导致 --resume
    // 显示自动生成的标题而不是用户设置的会话名称。
    reAppendSessionMetadata()

    // 为压缩前的消息写入精简的 transcript 片段（仅 assistant 模式）。
    // Fire-and-forget — 错误会在内部记录。
    if (feature('KAIROS')) {
      void (sessionTranscriptModule as any)?.writeSessionTranscriptSegment(messages)
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'post_compact',
    })
    const postCompactHookResult = await executePostCompactHooks(
      {
        trigger: isAutoCompact ? 'auto' : 'manual',
        compactSummary: summary,
      },
      context.abortController.signal,
    )

    const combinedUserDisplayMessage = [
      userDisplayMessage,
      postCompactHookResult.userDisplayMessage,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      boundaryMarker,
      summaryMessages,
      attachments: postCompactFileAttachments,
      hookResults: hookMessages,
      userDisplayMessage: combinedUserDisplayMessage || undefined,
      preCompactTokenCount,
      postCompactTokenCount: compactionCallTotalTokens,
      truePostCompactTokenCount,
      compactionUsage,
    }
  } catch (error) {
    // 仅对手动 /compact 显示错误通知。
    // 自动压缩失败会在下一轮重试，而且压缩最终成功时
    // 通知会让用户困惑。
    if (!isAutoCompact) {
      addErrorNotificationIfNeeded(error, context)
    }
    throw error
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

/**
 * 围绕选中的消息索引执行部分压缩。
 * 方向 'from'：摘要索引之后的消息，保留之前的消息。
 *   保留（较早）消息的 prompt cache 得以保留。
 * 方向 'up_to'：摘要索引之前的消息，保留之后的消息。
 *   prompt cache 会被失效，因为摘要在保留的消息之前。
 */
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from' as any,
): Promise<CompactionResult> {
  try {
    const messagesToSummarize =
      (direction as any) === 'up_to'
        ? allMessages.slice(0, pivotIndex)
        : allMessages.slice(pivotIndex)
    // 'up_to' 必须移除旧的压缩边界/摘要：对于 'up_to'，
    // summary_B 位于保留内容之前，所以 kept 中的陈旧 boundary_A
    // 会在 findLastCompactBoundaryIndex 的反向扫描中胜出并丢弃 summary_B。
    // 'from' 则保留它们：summary_B 位于保留内容之后（反向扫描仍然有效），
    // 而且移除旧摘要会丢失其覆盖的历史。
    const messagesToKeep =
      (direction as any) === 'up_to'
        ? allMessages
            .slice(pivotIndex)
            .filter(
              m =>
                m.type !== 'progress' &&
                !isCompactBoundaryMessage(m) &&
                !(m.type === 'user' && m.isCompactSummary),
            )
        : allMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')

    if (messagesToSummarize.length === 0) {
      throw new Error(
        (direction as any) === 'up_to'
          ? 'Nothing to summarize before the selected message.'
          : 'Nothing to summarize after the selected message.',
      )
    }

    const preCompactTokenCount = tokenCountWithEstimation(allMessages)

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'pre_compact',
    })

    context.setSDKStatus?.('compacting')
    const hookResult = await executePreCompactHooks(
      {
        trigger: 'manual',
        customInstructions: null,
      },
      context.abortController.signal,
    )

    // 合并 hook 指令和用户反馈
    let customInstructions: string | undefined
    if (hookResult.newCustomInstructions && userFeedback) {
      customInstructions = `${hookResult.newCustomInstructions}\n\nUser context: ${userFeedback}`
    } else if (hookResult.newCustomInstructions) {
      customInstructions = hookResult.newCustomInstructions
    } else if (userFeedback) {
      customInstructions = `User context: ${userFeedback}`
    }

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    const compactPrompt = getPartialCompactPrompt(customInstructions, direction)
    const summaryRequest = createUserMessage({
      content: compactPrompt,
    })

    const failureMetadata = {
      preCompactTokenCount,
      direction:
        direction as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      messagesSummarized: messagesToSummarize.length,
    }

    // 'up_to' 前缀直接命中 cache；'from' 发送全部（尾部不会 cache）。
    // PTL 重试会破坏 cache 前缀但能让用户继续操作（CC-1180）。
    let apiMessages = (direction as any) === ('up_to' as any) ? messagesToSummarize : allMessages
    let retryCacheSafeParams =
      (direction as any) === 'up_to'
        ? { ...cacheSafeParams, forkContextMessages: messagesToSummarize }
        : cacheSafeParams
    let summaryResponse: AssistantMessage
    let summary: string | null
    let ptlAttempts = 0
    for (;;) {
      summaryResponse = await streamCompactSummary({
        messages: apiMessages,
        summaryRequest,
        appState: context.getAppState(),
        context,
        preCompactTokenCount,
        cacheSafeParams: retryCacheSafeParams,
      })
      summary = getAssistantMessageText(summaryResponse)
      if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

      ptlAttempts++
      const truncated =
        ptlAttempts <= MAX_PTL_RETRIES
          ? truncateHeadForPTLRetry(apiMessages, summaryResponse)
          : null
      if (!truncated) {
        logEvent('tengu_partial_compact_failed', {
          reason:
            'prompt_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...failureMetadata,
          ptlAttempts,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      logEvent('tengu_compact_ptl_retry', {
        attempt: ptlAttempts,
        droppedMessages: apiMessages.length - truncated.length,
        remainingMessages: truncated.length,
        path: 'partial' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      apiMessages = truncated
      retryCacheSafeParams = {
        ...retryCacheSafeParams,
        forkContextMessages: truncated,
      }
    }
    if (!summary) {
      logEvent('tengu_partial_compact_failed', {
        reason:
          'no_summary' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...failureMetadata,
      })
      throw new Error(
        'Failed to generate conversation summary - response did not contain valid text content',
      )
    } else if (startsWithApiErrorPrefix(summary)) {
      logEvent('tengu_partial_compact_failed', {
        reason:
          'api_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...failureMetadata,
      })
      throw new Error(summary)
    }

    // 清除前保存当前文件状态
    const preCompactReadFileState = cacheToObject(context.readFileState)
    context.readFileState.clear()
    context.loadedNestedMemoryPaths?.clear()
    // 有意不重置 sentSkillNames — 参见 compactConversation() 中的理由（每次压缩节省约 4K token）。

    const [fileAttachments, asyncAgentAttachments] = await Promise.all([
      createPostCompactFileAttachments(
        preCompactReadFileState,
        context,
        POST_COMPACT_MAX_FILES_TO_RESTORE,
        messagesToKeep,
      ),
      createAsyncAgentAttachmentsIfNeeded(context),
    ])

    const postCompactFileAttachments: AttachmentMessage[] = [
      ...fileAttachments,
      ...asyncAgentAttachments,
    ]
    const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
    if (planAttachment) {
      postCompactFileAttachments.push(planAttachment)
    }

    // 如果当前处于 plan 模式，添加 plan mode 指令
    const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
    if (planModeAttachment) {
      postCompactFileAttachments.push(planModeAttachment)
    }

    const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
    if (skillAttachment) {
      postCompactFileAttachments.push(skillAttachment)
    }

    // 只重新声明被摘要部分中的内容 — messagesToKeep 会被扫描，
    // 所以其中已经声明的内容会被跳过。
    for (const att of getDeferredToolsDeltaAttachment(
      context.options.tools,
      context.options.mainLoopModel,
      messagesToKeep,
      { callSite: 'compact_partial' },
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getAgentListingDeltaAttachment(context, messagesToKeep)) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getMcpInstructionsDeltaAttachment(
      context.options.mcpClients,
      context.options.tools,
      context.options.mainLoopModel,
      messagesToKeep,
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'session_start',
    })
    const hookMessages = await processSessionStartHooks('compact', {
      model: context.options.mainLoopModel,
    })

    const postCompactTokenCount = tokenCountFromLastAPIResponse([
      summaryResponse,
    ])
    const compactionUsage = getTokenUsage(summaryResponse)

    logEvent('tengu_partial_compact', {
      preCompactTokenCount,
      postCompactTokenCount,
      messagesKept: messagesToKeep.length,
      messagesSummarized: messagesToSummarize.length,
      direction:
        direction as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasUserFeedback: !!userFeedback,
      trigger:
        'message_selector' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      compactionInputTokens: compactionUsage?.input_tokens,
      compactionOutputTokens: compactionUsage?.output_tokens,
      compactionCacheReadTokens: compactionUsage?.cache_read_input_tokens ?? 0,
      compactionCacheCreationTokens:
        compactionUsage?.cache_creation_input_tokens ?? 0,
    })

    // progress 消息无法记录日志，所以 forkSessionImpl 会将
    // 指向 progress 消息的 logicalParentUuid 置空。两个方向都跳过它们。
    const lastPreCompactUuid =
      (direction as any) === 'up_to'
        ? allMessages.slice(0, pivotIndex).findLast(m => m.type !== 'progress')
            ?.uuid
        : messagesToKeep.at(-1)?.uuid
    const boundaryMarker = createCompactBoundaryMessage(
      'manual',
      preCompactTokenCount ?? 0,
      (lastPreCompactUuid as any),
      userFeedback,
      messagesToSummarize.length,
    )
    // 用 allMessages 而不仅是 messagesToSummarize — 集合的并集是幂等的，
    // 比追踪每个工具在哪个半区更简单。
    const preCompactDiscovered = extractDiscoveredToolNames(allMessages)
    if (preCompactDiscovered.size > 0) {
      (boundaryMarker.compactMetadata as any).preCompactDiscoveredTools = [
        ...preCompactDiscovered,
      ].sort()
    }

    const transcriptPath = getTranscriptPath()
    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(summary, false, transcriptPath),
        isCompactSummary: true,
        ...(messagesToKeep.length > 0
          ? {
              summarizeMetadata: {
                messagesSummarized: messagesToSummarize.length,
                userContext: userFeedback,
                direction,
              },
            }
          : { isVisibleInTranscriptOnly: true as const }),
      }),
    ]

    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(
        (context.options.querySource ?? 'compact') as any,
        context.agentId,
      )
    }
    markPostCompaction()

    // 重新附加 session 元数据（自定义标题、标签），使其保持在
    // readLiteMetadata 读取的 16KB 尾部窗口内，供 --resume 显示使用。
    reAppendSessionMetadata()

    if (feature('KAIROS')) {
      void (sessionTranscriptModule as any)?.writeSessionTranscriptSegment(
        messagesToSummarize,
      )
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'post_compact',
    })
    const postCompactHookResult = await executePostCompactHooks(
      {
        trigger: 'manual',
        compactSummary: summary,
      },
      context.abortController.signal,
    )

    // 'from'：前缀保留 → 用 boundary；'up_to'：后缀 → 用最后一条摘要
    const anchorUuid =
      (direction as any) === 'up_to'
        ? (summaryMessages.at(-1)?.uuid ?? boundaryMarker.uuid)
        : boundaryMarker.uuid
    return {
      boundaryMarker: annotateBoundaryWithPreservedSegment(
        boundaryMarker,
        anchorUuid as any,
        (messagesToKeep as any) as any,
      ),
      summaryMessages,
      messagesToKeep,
      attachments: postCompactFileAttachments,
      hookResults: hookMessages,
      userDisplayMessage: postCompactHookResult.userDisplayMessage,
      preCompactTokenCount,
      postCompactTokenCount,
      compactionUsage,
    }
  } catch (error) {
    addErrorNotificationIfNeeded(error, context)
    throw error
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

function addErrorNotificationIfNeeded(
  error: unknown,
  context: Pick<ToolUseContext, 'addNotification'>,
) {
  if (
    !hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT) &&
    !hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  ) {
    context.addNotification?.({
      key: 'error-compacting-conversation',
      text: 'Error compacting conversation',
      priority: 'immediate',
      color: 'error',
    })
  }
}

export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other' as const,
      reason: 'compaction agent should only produce text summary',
    },
  })
}

async function streamCompactSummary({
  messages,
  summaryRequest,
  appState,
  context,
  preCompactTokenCount,
  cacheSafeParams,
}: {
  messages: Message[]
  summaryRequest: UserMessage
  appState: Awaited<ReturnType<ToolUseContext['getAppState']>>
  context: ToolUseContext
  preCompactTokenCount: number
  cacheSafeParams: CacheSafeParams
}): Promise<AssistantMessage> {
  // 启用 prompt cache 共享时，使用 forked agent 复用
  // 主对话已缓存的前缀（system prompt、tools、context 消息）。
  // 失败时回退到常规流式路径。
  // 第三方默认：true — 参见上方另一处 tengu_compact_cache_prefix 读取的注释。
  const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_cache_prefix',
    true,
  )
  // 压缩期间发送保活信号，防止远程 session WebSocket 因空闲超时而断开桥接连接。
  // 压缩 API 调用可能需要 5-10+ 秒，在此期间没有其他消息通过传输层 —
  // 没有保活信号的话，服务器可能会因不活动而关闭 WebSocket。
  // 两个信号：（1）通过 sessionActivity 发送 PUT /worker 心跳，
  // （2）重新发送 'compacting' 状态，保持 SDK 事件流活跃，
  // 防止服务器将会话视为过时。
  const activityInterval = isSessionActivityTrackingActive()
    ? setInterval(
        (statusSetter?: (status: 'compacting' | null) => void) => {
          sendSessionActivitySignal()
          statusSetter?.('compacting')
        },
        30_000,
        context.setSDKStatus,
      )
    : undefined

  try {
    if (promptCacheSharingEnabled) {
      try {
        // 不要在这里设置 maxOutputTokens。fork 通过发送相同的 cache-key 参数
        //（system、tools、model、messages 前缀、thinking config）来复用主线程的
        // prompt cache。设置 maxOutputTokens 会通过 Math.min(budget, maxOutputTokens-1)
        // 在 zy.ts 中缩减 budget_tokens，造成 thinking config 不匹配从而使 cache 失效。
        // 下面的流式回退路径可以安全地设置 maxOutputTokensOverride，
        // 因为它不与主线程共享 cache。
        const result = await runForkedAgent({
          promptMessages: [summaryRequest],
          cacheSafeParams,
          canUseTool: createCompactCanUseTool(),
          querySource: 'compact' as any,
          forkLabel: 'compact',
          maxTurns: 1,
          skipCacheWrite: true,
          // 传入压缩上下文的 abortController，这样用户按 Esc 可以中止
          // fork — 与下面流式回退路径在 `signal: context.abortController.signal` 使用相同的信号。
          overrides: { abortController: context.abortController },
        })
        const assistantMsg = getLastAssistantMessage(result.messages)
        const assistantText = assistantMsg
          ? getAssistantMessageText(assistantMsg)
          : null
        // 防护 isApiErrorMessage：query() 会捕获 API 错误（包括 ESC 时的
        // APIUserAbortError）并将它们作为合成的 assistant 消息返回。
        // 没有这个检查的话，被中止的压缩会"成功"地以 "Request was aborted."
        // 作为摘要 — 该文本不以 "API Error" 开头，所以调用者的
        // startsWithApiErrorPrefix 检查会漏掉它。
        if (assistantMsg && assistantText && !assistantMsg.isApiErrorMessage) {
          // PTL 错误文本不记录成功日志 — 它被返回以便调用者的重试循环捕获它，
          // 但它不是成功的摘要。
          if (!assistantText.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) {
            logEvent('tengu_compact_cache_sharing_success', {
              preCompactTokenCount,
              outputTokens: result.totalUsage.outputTokens,
              cacheReadInputTokens: result.totalUsage.cacheReadInputTokens,
              cacheCreationInputTokens:
                result.totalUsage.cacheCreationInputTokens,
              cacheHitRate:
                result.totalUsage.cacheReadInputTokens > 0
                  ? result.totalUsage.cacheReadInputTokens /
                    (result.totalUsage.cacheReadInputTokens +
                      result.totalUsage.cacheCreationInputTokens +
                      result.totalUsage.inputTokens)
                  : 0,
            })
          }
          return assistantMsg
        }
        logForDebugging(
          `Compact cache sharing: no text in response, falling back. Response: ${jsonStringify(assistantMsg)}`,
          { level: 'warn' },
        )
        logEvent('tengu_compact_cache_sharing_fallback', {
          reason:
            'no_text_response' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
        })
      } catch (error) {
        logError(error)
        logEvent('tengu_compact_cache_sharing_fallback', {
          reason:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
        })
      }
    }

    // 常规流式路径（cache 共享失败或被禁用时的回退）
    const retryEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_compact_streaming_retry',
      false,
    )
    const maxAttempts = retryEnabled ? MAX_COMPACT_STREAMING_RETRIES : 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 为重试重置状态
      let hasStartedStreaming = false
      let response: AssistantMessage | undefined
      context.setResponseLength?.(() => 0)

      // 检查 tool search 是否启用，使用主循环的工具列表。
      // context.options.tools 包含通过 useMergedTools 合并的 MCP 工具。
      const useToolSearch = await isToolSearchEnabled(
        context.options.mainLoopModel,
        context.options.tools,
        async () => appState.toolPermissionContext,
        context.options.agentDefinitions.activeAgents,
        'compact',
      )

      // 启用 tool search 时，包含 ToolSearchTool 和 MCP 工具。它们被设为
      // defer_loading: true，不计入上下文 — API 会在 token 计数前从
      // system_prompt_tools 中过滤掉它们（参见 api/token_count_api/counting.py:188
      // 和 api/public_api/messages/handler.py:324）。
      // 从 context.options.tools（而非 appState.mcp.tools）过滤 MCP 工具，
      // 这样我们拿到的是经过 useMergedTools 权限过滤后的集合 — 与上面
      // isToolSearchEnabled 和下面 normalizeMessagesForAPI 使用的来源一致。
      // 按名称去重，避免 MCP 工具与内置工具同名时产生 API 错误。
      const tools: Tool[] = useToolSearch
        ? uniqBy(
            [
              FileReadTool,
              ToolSearchTool,
              ...context.options.tools.filter(t => t.isMcp),
            ],
            'name',
          )
        : [FileReadTool]

      const streamingGen = queryModelWithStreaming({
        messages: normalizeMessagesForAPI(
          stripImagesFromMessages(
            stripReinjectedAttachments([
              ...getMessagesAfterCompactBoundary(messages),
              summaryRequest,
            ]),
          ),
          context.options.tools,
        ),
        systemPrompt: asSystemPrompt([
          'You are a helpful AI assistant tasked with summarizing conversations.',
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools,
        signal: context.abortController.signal,
        options: {
          async getToolPermissionContext() {
            const appState = context.getAppState()
            return appState.toolPermissionContext
          },
          model: context.options.mainLoopModel,
          toolChoice: undefined,
          isNonInteractiveSession: context.options.isNonInteractiveSession,
          hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
          maxOutputTokensOverride: Math.min(
            COMPACT_MAX_OUTPUT_TOKENS,
            getMaxOutputTokensForModel(context.options.mainLoopModel),
          ),
          querySource: 'compact' as any,
          agents: context.options.agentDefinitions.activeAgents,
          mcpTools: [],
          effortValue: appState.effortValue,
        },
      })
      const streamIter = streamingGen[Symbol.asyncIterator]()
      let next = await streamIter.next()

      while (!next.done) {
        const event = next.value

        if (
          !hasStartedStreaming &&
          (event as any).type === 'stream_event' &&
          (event as any).event.type === 'content_block_start' &&
          (event as any).event.content_block.type === 'text'
        ) {
          hasStartedStreaming = true
          context.setStreamMode?.('responding')
        }

        if (
          (event as any).type === 'stream_event' &&
          (event as any).event.type === 'content_block_delta' &&
          (event as any).event.delta.type === 'text_delta'
        ) {
          const charactersStreamed = (event as any).event.delta.text.length
          context.setResponseLength?.(length => length + charactersStreamed)
        }

        if ((event as any).type === 'assistant') {
          response = event as any
        }

        next = await streamIter.next()
      }

      if (response) {
        return response
      }

      if (attempt < maxAttempts) {
        logEvent('tengu_compact_streaming_retry', {
          attempt,
          preCompactTokenCount,
          hasStartedStreaming,
        })
        await sleep(getRetryDelay(attempt), context.abortController.signal, {
          abortError: () => createAbortError(),
        })
        continue
      }

      logForDebugging(
        `Compact streaming failed after ${attempt} attempts. hasStartedStreaming=${hasStartedStreaming}`,
        { level: 'error' },
      )
      logEvent('tengu_compact_failed', {
        reason:
          'no_streaming_response' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        hasStartedStreaming,
        retryEnabled,
        attempts: attempt,
        promptCacheSharingEnabled,
      })
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    }

    // 上面的 throw 之后永远不会执行到这里，但 TypeScript 需要它
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
  } finally {
    clearInterval(activityInterval)
  }
}

/**
 * 为最近访问的文件创建附件消息，在压缩后恢复它们。
 * 这样模型不需要重新读取最近访问过的文件。
 * 使用 FileReadTool 重新读取文件，获取带有适当验证的最新内容。
 * 文件选择基于访问时间的远近，但受文件数量和 token 预算的双重限制。
 *
 * 已在 preservedMessages 中以 Read 工具结果形式存在的文件会被跳过 —
 * 重新注入模型已经能在保留尾部看到的相同内容纯属浪费（每次压缩最多 25K token）。
 * 与 getDeferredToolsDeltaAttachment 在相同调用点使用的 diff-against-preserved 模式一致。
 *
 * @param readFileState 当前文件状态追踪，包含最近读取的文件
 * @param toolUseContext 调用 FileReadTool 的工具使用上下文
 * @param maxFiles 最多恢复的文件数（默认：5）
 * @param preservedMessages 压缩后保留的消息；其中的 Read 结果会被跳过
 * @returns 附件消息数组，包含在 token 预算内最近访问的文件
 */
export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  const preservedReadPaths = collectReadToolFilePaths(preservedMessages)
  const recentFiles = Object.entries(readFileState)
    .map(([filename, state]) => ({ filename, ...state }))
    .filter(
      file =>
        !shouldExcludeFromPostCompactRestore(
          file.filename,
          toolUseContext.agentId,
        ) && !preservedReadPaths.has(expandPath(file.filename)),
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)

  const results = await Promise.all(
    recentFiles.map(async file => {
      const attachment = await generateFileAttachment(
        file.filename,
        {
          ...toolUseContext,
          fileReadingLimits: {
            maxTokens: POST_COMPACT_MAX_TOKENS_PER_FILE,
          },
        },
        'tengu_post_compact_file_restore_success',
        'tengu_post_compact_file_restore_error',
        'compact',
      )
      return attachment ? createAttachmentMessage(attachment) : null
    }),
  )

  let usedTokens = 0
  return results.filter((result): result is AttachmentMessage => {
    if (result === null) {
      return false
    }
    const attachmentTokens = roughTokenCountEstimation(jsonStringify(result))
    if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
      usedTokens += attachmentTokens
      return true
    }
    return false
  })
}

/**
 * 如果当前会话存在 plan 文件，则创建 plan 文件附件。
 * 确保 plan 在压缩后得以保留。
 */
export function createPlanAttachmentIfNeeded(
  agentId?: AgentId,
): AttachmentMessage | null {
  const planContent = getPlan(agentId)

  if (!planContent) {
    return null
  }

  const planFilePath = getPlanFilePath(agentId)

  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath,
    planContent,
  })
}

/**
 * 为已调用的 skill 创建附件，使其内容在压缩后得以保留。
 * 仅包含作用域为给定 agent（或 agentId 为空时的主会话）的 skill。
 * 这样 skill 指南在对话被摘要后仍然可用，
 * 同时不会泄漏其他 agent 上下文的 skill。
 */
export function createSkillAttachmentIfNeeded(
  agentId?: string,
): AttachmentMessage | null {
  const invokedSkills = getInvokedSkillsForAgent(agentId)

  if (invokedSkills.size === 0) {
    return null
  }

  // 按最近调用优先排序。
  // 按 skill 截断保留每个文件的头部（通常包含设置/使用说明），
  // 而不是丢弃整个 skill。
  let usedTokens = 0
  const skills = Array.from(invokedSkills.values())
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map(skill => ({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncateToTokens(
        skill.content,
        POST_COMPACT_MAX_TOKENS_PER_SKILL,
      ),
    }))
    .filter(skill => {
      const tokens = roughTokenCountEstimation(skill.content)
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
        return false
      }
      usedTokens += tokens
      return true
    })

  if (skills.length === 0) {
    return null
  }

  return createAttachmentMessage({
    type: 'invoked_skills',
    skills,
  })
}

/**
 * 如果用户当前处于 plan 模式，创建 plan_mode 附件。
 * 确保模型在压缩后继续以 plan 模式运行
 *（否则会丢失 plan mode 指令，因为这些指令通常
 * 只在通过 getAttachmentMessages 的工具使用轮次中注入）。
 */
export async function createPlanModeAttachmentIfNeeded(
  context: ToolUseContext,
): Promise<AttachmentMessage | null> {
  const appState = context.getAppState()
  if (appState.toolPermissionContext.mode !== 'plan') {
    return null
  }

  const planFilePath = getPlanFilePath(context.agentId)
  const planExists = getPlan(context.agentId) !== null

  return createAttachmentMessage({
    type: 'plan_mode',
    reminderType: 'full',
    isSubAgent: !!context.agentId,
    planFilePath,
    planExists,
  })
}

/**
 * 为异步 agent 创建附件，这样模型在压缩后仍能知道它们的存在。
 * 覆盖仍在后台运行的 agent（这样模型不会生成重复的）以及
 * 已完成但结果尚未被检索的 agent。
 */
export async function createAsyncAgentAttachmentsIfNeeded(
  context: ToolUseContext,
): Promise<AttachmentMessage[]> {
  const appState = context.getAppState()
  const asyncAgents = Object.values(appState.tasks).filter(
    (task): task is LocalAgentTaskState => task.type === 'local_agent',
  )

  return asyncAgents.flatMap(agent => {
    if (
      agent.retrieved ||
      agent.status === 'pending' ||
      agent.agentId === context.agentId
    ) {
      return []
    }
    return [
      createAttachmentMessage({
        type: 'task_status',
        taskId: agent.agentId,
        taskType: 'local_agent',
        description: agent.description,
        status: agent.status,
        deltaSummary:
          agent.status === 'running'
            ? (agent.progress?.summary ?? null)
            : (agent.error ?? null),
        outputFilePath: getTaskOutputPath(agent.agentId),
      }),
    ]
  })
}

/**
 * 扫描消息中的 Read tool_use 块，收集它们的 file_path 输入
 *（通过 expandPath 归一化）。用于将压缩后文件恢复与
 * 保留尾部已可见的内容去重。
 *
 * 跳过 tool_result 为去重 stub 的 Read — stub 指向的完整 Read
 * 可能已被压缩掉，所以我们希望 createPostCompactFileAttachments
 * 重新注入真实内容。
 */
function collectReadToolFilePaths(messages: Message[]): Set<string> {
  const stubIds = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.startsWith(FILE_UNCHANGED_STUB)
      ) {
        stubIds.add(block.tool_use_id)
      }
    }
  }

  const paths = new Set<string>()
  for (const message of messages) {
    if (
      message.type !== 'assistant' ||
      !Array.isArray(message.message.content)
    ) {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type !== 'tool_use' ||
        block.name !== FILE_READ_TOOL_NAME ||
        stubIds.has(block.id)
      ) {
        continue
      }
      const input = block.input
      if (
        input &&
        typeof input === 'object' &&
        'file_path' in input &&
        typeof input.file_path === 'string'
      ) {
        paths.add(expandPath(input.file_path))
      }
    }
  }
  return paths
}

const SKILL_TRUNCATION_MARKER =
  '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'

/**
 * 将内容截断到约 maxTokens，保留头部。roughTokenCountEstimation
 * 使用约 4 字符/token（其默认的 bytesPerToken），所以字符预算 = maxTokens * 4
 * 减去标记长度，使结果保持在预算内。标记告诉模型如果需要可以 Read 完整文件。
 */
function truncateToTokens(content: string, maxTokens: number): string {
  if (roughTokenCountEstimation(content) <= maxTokens) {
    return content
  }
  const charBudget = maxTokens * 4 - SKILL_TRUNCATION_MARKER.length
  return content.slice(0, charBudget) + SKILL_TRUNCATION_MARKER
}

function shouldExcludeFromPostCompactRestore(
  filename: string,
  agentId?: AgentId,
): boolean {
  const normalizedFilename = expandPath(filename)
  // 排除 plan 文件
  try {
    const planFilePath = expandPath(getPlanFilePath(agentId))
    if (normalizedFilename === planFilePath) {
      return true
    }
  } catch {
    // 如果无法获取 plan 文件路径，继续其他检查
  }

  // 排除所有类型的 zy.md 文件
  // TODO: Refactor to use isMemoryFilePath() from zymd.ts for consistency
  // and to also match child directory memory files (.zy/rules/*.md, etc.)
  try {
    const normalizedMemoryPaths = new Set(
      MEMORY_TYPE_VALUES.map(type => expandPath(getMemoryPath(type))),
    )

    if (normalizedMemoryPaths.has(normalizedFilename)) {
      return true
    }
  } catch {
    // 如果无法获取 memory 路径，继续
  }

  return false
}
