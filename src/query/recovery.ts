import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isPromptTooLongMessage } from '../services/api/errors.js'
import type { AssistantMessage } from '../types/message.js'

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

function isWithheldMaxOutputTokens(msg: unknown): msg is AssistantMessage {
  const m = msg as Partial<AssistantMessage> | undefined
  return m?.type === 'assistant' && (m.apiError as unknown) === 'max_output_tokens'
}

// -- 决策类型

export type RecoveryDecision =
  | { action: 'collapse_drain' }
  | { action: 'reactive_compact'; isWithheldMedia: boolean }
  | { action: 'surface_ptl_error'; isWithheldMedia: boolean }
  | { action: 'surface_ptl_collapse_only' }
  | { action: 'mot_escalate' }
  | { action: 'mot_multi_turn'; attempt: number }
  | { action: 'mot_surface_error' }
  | { action: 'no_recovery_needed' }

export interface RecoveryContext {
  lastMessage: AssistantMessage | undefined
  isWithheldMedia: boolean
  hasContextCollapse: boolean
  previousTransitionReason: string | undefined
  hasReactiveCompact: boolean
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  maxOutputTokensRecoveryCount: number
}

// -- 主函数

export function diagnoseRecovery(ctx: RecoveryContext): RecoveryDecision {
  const { lastMessage } = ctx
  if (!lastMessage) {
    return { action: 'no_recovery_needed' }
  }

  const isWithheld413 =
    lastMessage.type === 'assistant' &&
    lastMessage.isApiErrorMessage &&
    isPromptTooLongMessage(lastMessage)

  const isWithheldMedia = ctx.isWithheldMedia

  // PTL / 媒体恢复链
  if (isWithheld413) {
    if (ctx.hasContextCollapse && ctx.previousTransitionReason !== 'collapse_drain_retry') {
      return { action: 'collapse_drain' }
    }
  }

  if ((isWithheld413 || isWithheldMedia) && ctx.hasReactiveCompact) {
    if (!ctx.hasAttemptedReactiveCompact) {
      return { action: 'reactive_compact', isWithheldMedia }
    }
    return { action: 'surface_ptl_error', isWithheldMedia }
  }

  if (ctx.hasContextCollapse && isWithheld413) {
    return { action: 'surface_ptl_collapse_only' }
  }

  // max_output_tokens 恢复
  if (isWithheldMaxOutputTokens(lastMessage)) {
    const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_otk_slot_v1', false)
    if (
      capEnabled &&
      ctx.maxOutputTokensOverride === undefined &&
      !process.env.ZY_CODE_MAX_OUTPUT_TOKENS
    ) {
      return { action: 'mot_escalate' }
    }

    if (ctx.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
      return { action: 'mot_multi_turn', attempt: ctx.maxOutputTokensRecoveryCount + 1 }
    }

    return { action: 'mot_surface_error' }
  }

  return { action: 'no_recovery_needed' }
}

export { isWithheldMaxOutputTokens, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT }
