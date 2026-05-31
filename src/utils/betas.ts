import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  ADVANCED_TOOL_USE_BETA_HEADER,
  CLI_INTERNAL_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_TOOL_BETA_HEADER,
} from '../constants/betas.js'
import { isEnvDefinedFalsy, isEnvTruthy, isInternalBuild } from './envUtils.js'
import {
  getAPIProvider,
  isAnthropicModel,
  modelHasCapability,
  providerHasCapability,
} from 'src/services/model/providers.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import { getContextWindowForModel } from './context.js'
import { getLocalModelBetaHeaders } from './settings/localModelCapabilities.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * SDK-provided betas that are allowed for API key users.
 * Only betas in this list can be passed via SDK options.
 */
const ALLOWED_SDK_BETAS: string[] = []

/**
 * Filter betas to only include those in the allowlist.
 * Returns allowed and disallowed betas separately.
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return {
    allowed,
    disallowed,
  }
}

/**
 * Filter SDK betas to only include allowed ones.
 * Warns about disallowed betas and subscriber restrictions.
 * Returns undefined if no valid betas remain or if user is a subscriber.
 */
export function filterAllowedSdkBetas(sdkBetas: string[] | undefined): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }
  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

// Generally, foundry supports all direct API features;
// however out of an abundance of caution, we do not enable any which are behind an experiment

// Context management is supported on providers that declare the capability
export function modelSupportsContextManagement(model: string): boolean {
  if (modelHasCapability(model, 'context_management')) {
    return true
  }
  const provider = getAPIProvider()
  if (provider === 'foundry') {
    return true
  }
  if (providerHasCapability(provider, 'context_management')) {
    return true
  }
  return false
}

// 1M 上下文模型仍需 context-1m beta header 才能解锁完整窗口——不发的话,即便
// 是支持的模型,API 也会把输入卡在 200k(见 opencode#12507)。按配置的上下文
// 窗口门控:凡在 model-capabilities.json 里设成 1M 的模型都带上它。
function modelSupports1MContext(model: string): boolean {
  return getContextWindowForModel(model) >= 1_000_000
}

// @[MODEL LAUNCH]: Add the new model ID to this list if it supports structured outputs.
export function modelSupportsStructuredOutputs(model: string): boolean {
  if (modelHasCapability(model, 'structured_outputs')) {
    return true
  }
  const provider = getAPIProvider()
  // Structured outputs only supported on providers that declare the capability
  if (!providerHasCapability(provider, 'structured_outputs')) {
    return false
  }
  return true
}

// @[MODEL LAUNCH]: Add the new model if it supports auto mode (specifically PI probes) — ask in #proj-zy-code-safety-research.
export function modelSupportsAutoMode(model: string): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Check settings-based auto_mode capability
    if (modelHasCapability(model, 'auto_mode')) {
      return true
    }
    // GrowthBook override: zy_auto_mode_config.allowModels force-enables
    // auto mode for listed models, bypassing the denylist/allowlist below.
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowModels?: string[]
    }>('zy_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        (am) => am.toLowerCase() === rawLower || am.toLowerCase() === model.toLowerCase(),
      )
    ) {
      return true
    }
    // 外部构建：仅通过 settings capability 或 GrowthBook allowModels 启用
    return false
  }
  return false
}

/**
 * 按当前 API provider 返回对应的 tool search beta header(取值同 Claude Code 的 oh9()):
 * - Vertex AI / Bedrock → tool-search-tool-2025-10-19
 * - Anthropic 直连 Messages API / Foundry → advanced-tool-use-2025-11-20
 *
 * bedrock 这里会算出对应值,但调用点会把它排除在 betas 数组外(bedrock 经
 * extraBodyParams 而非 header 下发 beta)。
 */
export function getToolSearchBetaHeader(): string {
  const provider = getAPIProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return TOOL_SEARCH_TOOL_BETA_HEADER
  }
  return ADVANCED_TOOL_USE_BETA_HEADER
}

/**
 * Check if experimental betas should be included.
 * These are betas that require specific provider capabilities
 * and may not be supported by proxies or other providers.
 */
export function shouldIncludeExperimentalBetas(model: string = getMainLoopModel() ?? ''): boolean {
  // anthropic-beta header 只对真 Claude 模型有意义——按 model id 判断,而非 provider
  // (openrouter/bedrock 等同一 provider 既可能跑 Claude 也可能跑别家)。模型不是
  // Claude 时这些 beta 会被拒,故按模型门控。无 model 入参时取主循环模型。
  return isAnthropicModel(model) && !isEnvTruthy(process.env.ZY_CODE_DISABLE_EXPERIMENTAL_BETAS)
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = model.toLowerCase().includes('haiku')
  const includeExperimentalBetas = shouldIncludeExperimentalBetas(model)
  if (!isHaiku) {
    if (
      isInternalBuild() &&
      process.env.ZY_CODE_ENTRYPOINT === 'cli' &&
      isAnthropicModel(model)
    ) {
      if (CLI_INTERNAL_BETA_HEADER) {
        betaHeaders.push(CLI_INTERNAL_BETA_HEADER)
      }
    }
  }
  // 模型配置为 1M 时解锁 1M 上下文窗口。即便是支持的模型也必需(见 opencode#12507)
  // ——否则 API 会悄悄把输入卡在 200k,而客户端却按 1M 预算。仅对 Claude 模型发。
  if (isAnthropicModel(model) && modelSupports1MContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  // POC: server-side connector-text summarization (anti-distillation). The
  // API buffers assistant text between tool calls, summarizes it, and returns
  // the summary with a signature so the original can be restored on subsequent
  // turns — same mechanism as thinking blocks. Ant-only while we measure
  // TTFT/TTLT/capacity; betas already flow to zy_api_success for splitting.
  // Backend independently requires Capability.ANTHROPIC_INTERNAL_RESEARCH.
  //
  // USE_CONNECTOR_TEXT_SUMMARIZATION is tri-state: =1 forces on (opt-in even
  // if GB is off), =0 forces off (opt-out of a GB rollout you were bucketed
  // into), unset defers to GB.
  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    isInternalBuild() &&
    includeExperimentalBetas &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('zy_slate_prism', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  // Add context management beta for tool clearing (ant opt-in) or thinking preservation
  const antOptedIntoToolClearing =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) && isInternalBuild()
  const thinkingPreservationEnabled = modelSupportsContextManagement(model)
  if (includeExperimentalBetas && (antOptedIntoToolClearing || thinkingPreservationEnabled)) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // strict tool use:schema.strict 字段在 api.ts 设置(由本 flag +
  // modelSupportsStructuredOutputs 门控)。structured outputs 已 GA,故不发
  // beta header——该字段作为 GA 参数直接下发。
  const strictToolsEnabled = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_strict_tools')
  // 3P default: false. API rejects strict + token-efficient-tools together
  // (tool_use.py:139), so these are mutually exclusive — strict wins.
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled && getFeatureValue_CACHED_MAY_BE_STALE('zy_json_tools_beta', false)
  // JSON tool_use format (FC v3) — ~4.5% output token reduction vs ANTML.
  // Sends the v2 header (2026-03-28) added in anthropics/anthropic#337072 to
  // isolate the CC A/B cohort from ~9.2M/week existing v1 senders. Ant-only
  // while the restored JsonToolUseOutputParser soaks.
  if (isInternalBuild() && includeExperimentalBetas && tokenEfficientToolsEnabled) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  // 模型级 anthropic-beta:从 model-capabilities.json 的 betaHeaders 透传。按模型粒度、
  // 用户显式 opt-in,故不经上方的 provider/feature 门控;去重避免与已添加项重复。
  const modelBetaHeaders = getLocalModelBetaHeaders(model)
  if (modelBetaHeaders) {
    for (const header of modelBetaHeaders) {
      if (header && !betaHeaders.includes(header)) {
        betaHeaders.push(header)
      }
    }
  }

  // If ANTHROPIC_BETAS is set, split it by commas and add to betaHeaders.
  // This is an explicit user opt-in, so honor it regardless of model.
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map((_) => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})
export const getModelBetas = memoize((model: string): string[] => {
  return getAllModelBetas(model)
})

/**
 * Merge SDK-provided betas with auto-detected model betas.
 * SDK betas are read from global state (set via setSdkBetas in main.tsx).
 * The betas are pre-filtered by filterAllowedSdkBetas which handles
 * subscriber checks and allowlist validation with warnings.
 *
 * @param options.isAgenticQuery - When true, ensures the beta headers needed
 *   for agentic queries are present. For non-Haiku models these are already
 *   included by getAllModelBetas(); for Haiku they're excluded since
 *   non-agentic calls (compaction, classifiers, token estimation) don't need them.
 */
export function getMergedBetas(
  model: string,
  options?: {
    isAgenticQuery?: boolean
  },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // agentic 查询始终需要 cli-internal beta header。非 Haiku 模型它已在 baseBetas
  // 里;Haiku 则被 getAllModelBetas() 排除(非 agentic 的 Haiku 调用用不上)。
  if (options?.isAgenticQuery) {
    if (
      isInternalBuild() &&
      process.env.ZY_CODE_ENTRYPOINT === 'cli' &&
      CLI_INTERNAL_BETA_HEADER &&
      !baseBetas.includes(CLI_INTERNAL_BETA_HEADER)
    ) {
      baseBetas.push(CLI_INTERNAL_BETA_HEADER)
    }
  }
  const sdkBetas = getSdkBetas()
  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // Merge SDK betas without duplicates (already filtered by filterAllowedSdkBetas)
  return [...baseBetas, ...sdkBetas.filter((b) => !baseBetas.includes(b))]
}
export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}
