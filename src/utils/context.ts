// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { isInternalBuild } from './envUtils.js'
import { modelHasCapability, getModelMaxOutputTokensFromSettings } from './model/providers.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { getLocalMaxOutputTokens } from './settings/localModelCapabilities.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// zy.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = model.toLowerCase()
  return canonical.includes('qwen3.6-plus') || modelHasCapability(model, '1m_context')
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    isInternalBuild() &&
    process.env.ZY_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.ZY_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  const canonical = model.toLowerCase()
  if (!canonical.includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    inputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.inputTokens +
    currentUsage.cacheCreationInputTokens +
    currentUsage.cacheReadInputTokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 *
 * 优先级：
 * 1. settings.json modelCapabilities 配置（用户自定义，优先）
 * 2. ~/.zy/model-capabilities.json 本地模型能力配置
 * 3. 通用默认值
 * 4. API 缓存的 max_tokens 覆盖
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  // 1. settings.json 用户自定义配置优先
  const settingsValue = getModelMaxOutputTokensFromSettings(model)
  if (settingsValue) {
    return settingsValue
  }

  // 2. ~/.zy/model-capabilities.json 本地配置
  const localTokens = getLocalMaxOutputTokens(model)
  const defaultTokens = localTokens?.default ?? MAX_OUTPUT_TOKENS_DEFAULT
  let upperLimit = localTokens?.upperLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT

  // 3. API 缓存覆盖
  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    if (defaultTokens > upperLimit) {
      return { default: upperLimit, upperLimit }
    }
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
