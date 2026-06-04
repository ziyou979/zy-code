import { feature } from 'bun:bundle'
import { markPostCompaction } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  HookResultMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import {
  createAttachmentMessage,
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { runForkedAgent } from '../../utils/forkedAgent.js'
import { executePostCompactHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  getAssistantMessageText,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import {
  getTokenUsage,
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
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

// ---------------------------------------------------------------------------
// Feature gates
// ---------------------------------------------------------------------------

/**
 * Whether reactive compact is enabled for this session.
 * Consulted by the query loop to gate media-error withholding and
 * to suppress proactive auto-compact when reactive owns recovery.
 */
export function isReactiveCompactEnabled(): boolean {
  return isAutoCompactEnabled() && getFeatureValue_CACHED_MAY_BE_STALE('zy_cobalt_raccoon', false)
}

/**
 * Whether we are in "reactive-only" mode — proactive auto-compact is
 * suppressed and `/compact` routes through the reactive path instead
 * of the traditional summarization pipeline.
 */
export function isReactiveOnlyMode(): boolean {
  return isReactiveCompactEnabled()
}

// ---------------------------------------------------------------------------
// Message withholding predicates
// ---------------------------------------------------------------------------

/**
 * Should this message be withheld from the user during streaming?
 * Returns true for prompt-too-long API error messages so the query loop
 * can attempt reactive recovery before surfacing the error.
 */
export function isWithheldPromptTooLong(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const assistantMsg = message as AssistantMessage
  return assistantMsg.isApiErrorMessage === true && isPromptTooLongMessage(assistantMsg)
}

/**
 * Should this media-size error message be withheld?
 * Returns true for image/PDF size rejection errors that reactive compact
 * can recover from by stripping media and retrying.
 */
export function isWithheldMediaSizeError(message: Message): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const assistantMsg = message as AssistantMessage
  return assistantMsg.isApiErrorMessage === true && isMediaSizeErrorMessage(assistantMsg)
}

// ---------------------------------------------------------------------------
// Core reactive compact
// ---------------------------------------------------------------------------

/** Maximum number of group-stripping iterations before giving up. */
const MAX_STRIP_ITERATIONS = 10

type ReactiveOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
    }

/**
 * Attempt to compact a conversation that is too long for the API.
 *
 * Strategy:
 * 1. Group messages by API round (each assistant response = one group).
 * 2. Strip images from messages (they inflate token count massively).
 * 3. Build a compact prompt and attempt summarization via forked agent.
 * 4. If the summarization itself hits prompt-too-long, drop the oldest
 *    group(s) and retry — using the token gap from the error to skip
 *    multiple groups at once when possible.
 * 5. On success, build a CompactionResult with boundary marker, summary,
 *    preserved tail messages, and re-injected attachments.
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

  // Strip images and re-injectable attachments to reduce token count
  // before sending to the summarization model.
  let messagesToSummarize = stripReinjectedAttachments(stripImagesFromMessages(messages))
  let groupsRemaining = groups.length

  const compactPrompt = getCompactPrompt(options.customInstructions ?? undefined)
  const summaryRequest = createUserMessage({
    content: [{ type: 'text' as const, text: compactPrompt }],
  })

  // Iteratively attempt summarization, dropping oldest groups on PTL failure
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

      const assistantMsg = getLastAssistantMessage(result.messages)
      const summaryText = assistantMsg ? getAssistantMessageText(assistantMsg) : null

      // Check for abort during the API call
      if (assistantMsg?.isApiErrorMessage) {
        if (summaryText?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && assistantMsg) {
          // Summarization itself hit PTL — drop oldest groups and retry
          const tokenGap = getPromptTooLongTokenGap(assistantMsg)
          const groupsToDrop = estimateGroupsToDrop(
            groups,
            groups.length - groupsRemaining,
            tokenGap,
          )

          if (groupsToDrop === 0) {
            // Can't drop any more groups
            logForDebugging('reactiveCompact: cannot drop more groups, exhausted')
            return { ok: false, reason: 'exhausted' }
          }

          groupsRemaining -= groupsToDrop
          if (groupsRemaining < 1) {
            return { ok: false, reason: 'exhausted' }
          }

          // Rebuild messagesToSummarize from remaining groups
          const keptGroups = groups.slice(groups.length - groupsRemaining)
          messagesToSummarize = stripReinjectedAttachments(
            stripImagesFromMessages(keptGroups.flat()),
          )

          logForDebugging(
            `reactiveCompact: PTL retry, dropped ${groupsToDrop} groups, ${groupsRemaining} remaining`,
          )
          continue
        }

        // Other API error — not recoverable
        logForDebugging(`reactiveCompact: API error during summarization: ${summaryText}`, {
          level: 'error',
        })
        return { ok: false, reason: 'error' }
      }

      if (!summaryText) {
        logForDebugging('reactiveCompact: empty summary response', {
          level: 'error',
        })
        return { ok: false, reason: 'error' }
      }

      // Success — build the CompactionResult
      const formattedSummary = formatCompactSummary(summaryText)
      const compactionResult = await buildReactiveCompactionResult({
        messages,
        formattedSummary,
        groups,
        groupsRemaining,
        preCompactTokenCount,
        assistantMsg: assistantMsg!,
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
        // biome-ignore lint/suspicious/noExplicitAny: 压缩服务类型处理
        error: String(error) as any,
        iteration,
      })
      return { ok: false, reason: 'error' }
    }
  }

  // Exhausted all iterations
  logForDebugging('reactiveCompact: exhausted all strip iterations')
  return { ok: false, reason: 'exhausted' }
}

// ---------------------------------------------------------------------------
// tryReactiveCompact — query-loop entry point
// ---------------------------------------------------------------------------

/**
 * Called from the query loop when a prompt-too-long or media-size error
 * is withheld. Wraps reactiveCompactOnPromptTooLong with guard checks
 * and post-success cleanup.
 *
 * Returns a CompactionResult on success, or null if recovery is not
 * possible (already attempted, aborted, or compact failed).
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean
  querySource?: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  // Guard: only attempt once per query-loop iteration to prevent
  // infinite compact → still too long → compact → … spirals.
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
      // biome-ignore lint/suspicious/noExplicitAny: 压缩服务类型处理
      logForDebugging(`reactiveCompact: tryReactiveCompact failed: ${(outcome as any).reason}`)
      return null
    }

    // Post-success cleanup — mirrors compactViaReactive in compact command
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimate how many groups to drop based on the token gap reported
 * by the prompt-too-long error. Falls back to dropping one group
 * if the gap is unknown.
 */
function estimateGroupsToDrop(
  groups: Message[][],
  alreadyDropped: number,
  tokenGap: number | undefined,
): number {
  if (tokenGap === undefined || tokenGap <= 0) {
    // No gap info — drop one group at a time
    return 1
  }

  // Walk from the first un-dropped group forward, accumulating tokens
  // until we've freed enough to cover the gap (with 10% margin).
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
 * Build a CompactionResult from a successful reactive compact summarization.
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

  // Preserved tail messages — the groups that were NOT summarized
  const preservedGroups = groups.slice(groups.length - groupsRemaining)
  const messagesToKeep = groupsRemaining < groups.length ? preservedGroups.flat() : undefined

  // Boundary marker
  // biome-ignore lint/suspicious/noExplicitAny: 压缩服务类型处理
  const lastMessageUuid = (messages.at(-1)?.uuid as any) ?? undefined
  const boundaryMarker = createCompactBoundaryMessage(
    trigger === 'manual' ? 'manual' : 'auto',
    preCompactTokenCount,
    lastMessageUuid,
  )

  // Summary messages
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

  // Re-inject attachments that compact consumed
  const attachments: AttachmentMessage[] = []
  const preservedMessages = messagesToKeep ?? []

  for (const att of getDeferredToolsDeltaAttachment(
    context.options.tools,
    context.options.mainLoopModel,
    preservedMessages,
    // biome-ignore lint/suspicious/noExplicitAny: 压缩服务类型处理
    { callSite: 'reactive_compact' as any },
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

  // Execute PostCompact hooks
  let hookUserDisplayMessage: string | undefined
  const hookResults: HookResultMessage[] = []
  try {
    const hookResult = await executePostCompactHooks(
      { trigger, compactSummary: formattedSummary },
      context.abortController.signal,
    )
    hookUserDisplayMessage = hookResult.userDisplayMessage
  } catch {
    // Hook failures should not block compaction
  }

  // biome-ignore lint/suspicious/noExplicitAny: 压缩服务类型处理
  const compactionUsage = getTokenUsage(assistantMsg as any)
  const postCompactTokenCount = tokenCountFromLastAPIResponse([assistantMsg])

  return {
    boundaryMarker,
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
    userDisplayMessage: hookUserDisplayMessage,
    preCompactTokenCount,
    postCompactTokenCount,
    compactionUsage,
  }
}
