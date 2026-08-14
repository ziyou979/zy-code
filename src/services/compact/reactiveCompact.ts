import type { UUID } from 'node:crypto'
import { feature } from 'bun:bundle'
import { markPostCompaction } from '../../bootstrap/runtime/runtimeContext.js'
import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { logForDebugging } from '../../services/infra/debug.js'
import type { CacheSafeParams } from '../../services/agent/forkedAgent.js'
import { runForkedAgent } from '../../services/agent/forkedAgent.js'
import { logError } from '../../services/infra/log.js'
import { createCompactBoundaryMessage, createUserMessage } from '../messages/constructors.js'
import { getAssistantMessageText, getLastAssistantMessage } from '../messages/predicates.js'
import {
  getTokenUsage,
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from '../../services/api/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  getPromptTooLongTokenGap,
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from '../api/errors.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import {
  createAttachmentMessage,
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from '../attachments/attachments.js'
import { executePostCompactHooks } from '../hooks.js'
import { isAutoCompactEnabled } from './autoCompact.js'
import type { CompactionResult } from './compact.js'
import {
  createCompactCanUseTool,
  stripImagesFromMessages,
  stripReinjectedAttachments,
} from './compact.js'
import { suppressCompactWarning } from './compactWarningState.js'
import { groupMessagesByApiRound } from './grouping.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { formatCompactSummary, getCompactPrompt, getCompactUserSummaryMessage } from './prompt.js'
import { getCompactSummaryText, pickCompactSummaryAssistant } from './summarySelection.js'

// ---------------------------------------------------------------------------
// 功能开关
// ---------------------------------------------------------------------------

/**
 * 当前会话是否启用 reactive compact。
 * query loop 据此决定是否暂不展示媒体错误，并在 reactive 负责恢复时
 * 禁用主动 auto-compact。
 */
export function isReactiveCompactEnabled(): boolean {
  return isAutoCompactEnabled() && getFeatureValue_CACHED_MAY_BE_STALE('zy_cobalt_raccoon', false)
}

/**
 * 是否处于“仅 reactive”模式：禁用主动 auto-compact，且 `/compact`
 * 改走 reactive 路径，而非传统摘要流程。
 */
export function isReactiveOnlyMode(): boolean {
  return isReactiveCompactEnabled()
}

// ---------------------------------------------------------------------------
// 消息暂缓展示条件
// ---------------------------------------------------------------------------

/**
 * 流式传输期间是否应暂缓向用户展示该消息。
 * 对 prompt-too-long API 错误返回 true，让 query loop 在展示错误前
 * 先尝试 reactive 恢复。
 */
export function isWithheldPromptTooLong(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const assistantMsg = message as AssistantMessage
  return assistantMsg.isApiErrorMessage === true && isPromptTooLongMessage(assistantMsg)
}

/**
 * 是否应暂缓展示该媒体大小错误。
 * 对可由 reactive compact 通过移除媒体并重试来恢复的图片/PDF
 * 大小拒绝错误返回 true。
 */
export function isWithheldMediaSizeError(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const assistantMsg = message as AssistantMessage
  return assistantMsg.isApiErrorMessage === true && isMediaSizeErrorMessage(assistantMsg)
}

// ---------------------------------------------------------------------------
// reactive compact 核心逻辑
// ---------------------------------------------------------------------------

/** 放弃前最多尝试移除消息组的次数。 */
const MAX_STRIP_ITERATIONS = 10

type ReactiveOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
    }

/**
 * 尝试压缩超出 API 长度限制的会话。
 *
 * 策略：
 * 1. 按 API 轮次为消息分组（每条 assistant 响应为一组）。
 * 2. 从消息中移除图片，避免其大幅增加 token 数量。
 * 3. 构造 compact prompt，并通过 forked agent 尝试生成摘要。
 * 4. 若生成摘要时仍遇到 prompt-too-long，则丢弃最早的消息组后重试；
 *    可取得错误中的 token 缺口时，尽量一次跳过多组。
 * 5. 成功后构造 CompactionResult，其中包含边界标记、摘要、
 *    保留的尾部消息以及重新注入的附件。
 */
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: {
    customInstructions?: string | null
    trigger: 'manual' | 'auto'
  },
): Promise<ReactiveOutcome> {
  const groups = groupMessagesByApiRound(messages)

  if (groups.length < 2) {
    logForDebugging('reactiveCompact: too few groups to compact', {
      level: 'warn',
    })
    return { ok: false, reason: 'too_few_groups' }
  }

  const preCompactTokenCount = tokenCountWithEstimation(messages)
  const abortSignal = cacheSafeParams.toolUseContext.abortController.signal

  // 发送给摘要模型前移除图片和可重新注入的附件，以减少 token 数量。
  let messagesToSummarize = stripReinjectedAttachments(stripImagesFromMessages(messages))
  let groupsRemaining = groups.length

  const compactPrompt = getCompactPrompt(options.customInstructions ?? undefined)
  const summaryRequest = createUserMessage({
    content: [{ type: 'text' as const, text: compactPrompt }],
  })

  // 迭代尝试生成摘要；遇到 PTL 失败时丢弃最早的消息组。
  for (let iteration = 0; iteration < MAX_STRIP_ITERATIONS; iteration++) {
    if (abortSignal.aborted) {
      return { ok: false, reason: 'aborted' }
    }

    try {
      const result = await runForkedAgent({
        promptMessages: [summaryRequest],
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: messagesToSummarize,
        },
        canUseTool: createCompactCanUseTool(),
        querySource: 'compact',
        forkLabel: 'reactive_compact',
        maxTurns: 1,
        skipCacheWrite: true,
        overrides: {
          abortController: cacheSafeParams.toolUseContext.abortController,
        },
      })

      // 错误检测用最后一条 assistant（可能 isApiErrorMessage）；
      // 成功路径用 zQn 语义选取含 <summary> 的消息，避免思考草稿
      const lastAssistant = getLastAssistantMessage(result.messages)
      const lastText = lastAssistant ? getAssistantMessageText(lastAssistant) : null

      // 检查 API 调用期间是否中止或发生错误。
      if (lastAssistant?.isApiErrorMessage) {
        if (lastText?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) {
          // 生成摘要本身遇到 PTL：丢弃最早的消息组后重试。
          const tokenGap = getPromptTooLongTokenGap(lastAssistant)
          const groupsToDrop = estimateGroupsToDrop(
            groups,
            groups.length - groupsRemaining,
            tokenGap,
          )

          if (groupsToDrop === 0) {
            // 已无更多消息组可丢弃。
            logForDebugging('reactiveCompact: cannot drop more groups, exhausted')
            return { ok: false, reason: 'exhausted' }
          }

          groupsRemaining -= groupsToDrop
          if (groupsRemaining < 1) {
            return { ok: false, reason: 'exhausted' }
          }

          // 根据剩余消息组重建 messagesToSummarize。
          const keptGroups = groups.slice(groups.length - groupsRemaining)
          messagesToSummarize = stripReinjectedAttachments(
            stripImagesFromMessages(keptGroups.flat()),
          )

          logForDebugging(
            `reactiveCompact: PTL retry, dropped ${groupsToDrop} groups, ${groupsRemaining} remaining`,
          )
          continue
        }

        // 其他 API 错误无法由此流程恢复。
        logForDebugging(`reactiveCompact: API error during summarization: ${lastText}`, {
          level: 'error',
        })
        return { ok: false, reason: 'error' }
      }

      const assistantMsg = pickCompactSummaryAssistant(result.messages) ?? lastAssistant
      const summaryText = getCompactSummaryText(result.messages) ?? lastText

      if (!summaryText || !assistantMsg) {
        logForDebugging('reactiveCompact: empty summary response', {
          level: 'error',
        })
        return { ok: false, reason: 'error' }
      }

      // 摘要成功，构造 CompactionResult。
      const formattedSummary = formatCompactSummary(summaryText)
      const compactionResult = await buildReactiveCompactionResult({
        messages,
        formattedSummary,
        groups,
        groupsRemaining,
        preCompactTokenCount,
        assistantMsg,
        cacheSafeParams,
        trigger: options.trigger,
      })

      logEvent('zy_reactive_compact_success', {
        trigger: options.trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        groupsTotal: groups.length,
        groupsDropped: groups.length - groupsRemaining,
        iterations: iteration + 1,
      })

      return { ok: true, result: compactionResult }
    } catch (error) {
      if (abortSignal.aborted) {
        return { ok: false, reason: 'aborted' }
      }
      logError(error as Error)
      logEvent('zy_reactive_compact_error', {
        error: true,
        iteration,
      })
      return { ok: false, reason: 'error' }
    }
  }

  // 已用尽全部迭代次数。
  logForDebugging('reactiveCompact: exhausted all strip iterations')
  return { ok: false, reason: 'exhausted' }
}

// ---------------------------------------------------------------------------
// tryReactiveCompact：query loop 入口
// ---------------------------------------------------------------------------

/**
 * query loop 暂缓展示 prompt-too-long 或媒体大小错误时调用。
 * 在 reactiveCompactOnPromptTooLong 外增加前置检查和成功后的清理。
 *
 * 成功时返回 CompactionResult；无法恢复（已尝试、中止或 compact 失败）
 * 时返回 null。
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean
  querySource?: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  // 每轮 query loop 只尝试一次，避免 compact → 仍过长 → compact → … 的无限循环。
  if (params.hasAttempted) {
    logForDebugging('reactiveCompact: already attempted, skipping')
    return null
  }

  if (params.aborted) {
    return null
  }

  try {
    const outcome = await reactiveCompactOnPromptTooLong(params.messages, params.cacheSafeParams, {
      trigger: 'auto',
    })

    if (!outcome.ok) {
      logForDebugging(`reactiveCompact: tryReactiveCompact failed: ${outcome.reason}`)
      return null
    }

    // 成功后执行清理，与 compact 命令中的 compactViaReactive 保持一致。
    runPostCompactCleanup(params.querySource)
    suppressCompactWarning()

    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(params.querySource ?? 'compact')
    }
    markPostCompaction()

    return outcome.result
  } catch (error) {
    logError(error as Error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/**
 * 根据 prompt-too-long 错误报告的 token 缺口估算应丢弃的消息组数量。
 * 无法取得缺口时，退回到每次丢弃一组。
 */
function estimateGroupsToDrop(
  groups: Message[][],
  alreadyDropped: number,
  tokenGap: number | undefined,
): number {
  if (tokenGap === undefined || tokenGap <= 0) {
    // 没有缺口信息时，每次丢弃一组。
    return 1
  }

  // 从第一组尚未丢弃的消息开始向后累加 token，直至释放量足以覆盖缺口，
  // 并额外保留 10% 余量。
  const targetTokens = tokenGap * 1.1
  let accumulated = 0
  let groupsToDrop = 0

  for (let i = alreadyDropped; i < groups.length - 1; i++) {
    accumulated += tokenCountWithEstimation(groups[i]!)
    groupsToDrop++
    if (accumulated >= targetTokens) {
      break
    }
  }

  return Math.max(1, groupsToDrop)
}

/**
 * 根据成功生成的 reactive compact 摘要构造 CompactionResult。
 */
async function buildReactiveCompactionResult({
  messages,
  formattedSummary,
  groups,
  groupsRemaining,
  preCompactTokenCount,
  assistantMsg,
  cacheSafeParams,
  trigger,
}: {
  messages: Message[]
  formattedSummary: string
  groups: Message[][]
  groupsRemaining: number
  preCompactTokenCount: number
  assistantMsg: AssistantMessage
  cacheSafeParams: CacheSafeParams
  trigger: 'manual' | 'auto'
}): Promise<CompactionResult> {
  const context = cacheSafeParams.toolUseContext

  // 保留未纳入摘要的尾部消息组。
  const preservedGroups = groups.slice(groups.length - groupsRemaining)
  const messagesToKeep = groupsRemaining < groups.length ? preservedGroups.flat() : undefined

  // 边界标记。
  const lastMessageUuid = messages.at(-1)?.uuid as UUID | undefined
  const boundaryMarker = createCompactBoundaryMessage(
    trigger === 'manual' ? 'manual' : 'auto',
    preCompactTokenCount,
    lastMessageUuid,
  )

  // 摘要消息。
  const summaryMessages: UserMessage[] = [
    createUserMessage({
      content: [
        {
          type: 'text' as const,
          text: getCompactUserSummaryMessage(
            formattedSummary,
            /* suppressFollowUpQuestions */ true,
          ),
        },
      ],
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  // 重新注入 compact 已消费的附件。
  const attachments: AttachmentMessage[] = []
  const preservedMessages = messagesToKeep ?? []

  for (const att of getDeferredToolsDeltaAttachment(
    context.options.tools,
    context.options.mainLoopModel,
    preservedMessages,
    { callSite: 'reactive_compact' },
  )) {
    attachments.push(createAttachmentMessage(att))
  }
  for (const att of getAgentListingDeltaAttachment(context, preservedMessages)) {
    attachments.push(createAttachmentMessage(att))
  }
  for (const att of getMcpInstructionsDeltaAttachment(
    context.options.mcpClients,
    context.options.tools,
    context.options.mainLoopModel,
    preservedMessages,
  )) {
    attachments.push(createAttachmentMessage(att))
  }

  // 执行 PostCompact hooks。
  let hookUserDisplayMessage: string | undefined
  const hookResults: Message[] = []
  try {
    const hookResult = await executePostCompactHooks(
      { trigger, compactSummary: formattedSummary },
      context.abortController.signal,
    )
    hookUserDisplayMessage = hookResult.userDisplayMessage
  } catch {
    // Hook 失败不应阻塞压缩流程。
  }

  const compactionUsage = getTokenUsage(assistantMsg)
  const postCompactTokenCount = tokenCountFromLastAPIResponse([assistantMsg])

  // statusline：边界后尚无新 API usage 时用 postTokens 显示压缩后比例
  const truePostCompactTokenCount = tokenCountWithEstimation([
    boundaryMarker,
    ...summaryMessages,
    ...(messagesToKeep ?? []),
    ...attachments,
    ...hookResults,
  ])
  boundaryMarker.compactMetadata.postTokens = truePostCompactTokenCount

  return {
    boundaryMarker,
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
    userDisplayMessage: hookUserDisplayMessage,
    preCompactTokenCount,
    postCompactTokenCount,
    truePostCompactTokenCount,
    compactionUsage,
  }
}
