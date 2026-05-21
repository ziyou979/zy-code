import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  CLI_INTERNAL_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
  WEB_SEARCH_BETA_HEADER,
  ZY_CODE_,
} from '../constants/betas.js'
import { isEnvDefinedFalsy, isEnvTruthy, isInternalBuild } from './envUtils.js'
import { getAPIProvider, modelHasCapability, providerHasCapability } from './model/providers.js'
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

export function modelSupportsISP(model: string): boolean {
  // 模型能力配置优先
  if (modelHasCapability(model, 'interleaved_thinking')) {
    return true
  }
  const provider = getAPIProvider()
  // Foundry supports interleaved thinking for all models
  if (provider === 'foundry') {
    return true
  }
  if (providerHasCapability(provider, 'interleaved_thinking')) {
    return true
  }
  return false
}
function vertexModelSupportsWebSearch(model: string): boolean {
  if (modelHasCapability(model, 'web_search')) {
    return true
  }
  return false
}

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
    if (isInternalBuild()) {
      return true
    }
    // 外部构建：仅通过 settings capability 或 GrowthBook allowModels 启用
    return false
  }
  return false
}

/**
 * Get the correct tool search beta header for the current API provider.
 * - Zy API / Foundry: advanced-tool-use-2025-11-20
 * - Vertex AI / Bedrock: tool-search-tool-2025-10-19
 */
export function getToolSearchBetaHeader(): string {
  return TOOL_SEARCH_BETA_HEADER_1P
}

/**
 * Check if experimental betas should be included.
 * These are betas that require specific provider capabilities
 * and may not be supported by proxies or other providers.
 */
export function shouldIncludeExperimentalBetas(): boolean {
  return (
    providerHasCapability(getAPIProvider(), 'interleaved_thinking') &&
    !isEnvTruthy(process.env.ZY_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Global-scope prompt caching is direct API only. Foundry is excluded because
 * GrowthBook never bucketed Foundry users into the rollout experiment — the
 * treatment data is direct API-only.
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    providerHasCapability(getAPIProvider(), 'prompt_caching') &&
    !isEnvTruthy(process.env.ZY_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}
export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = model.toLowerCase().includes('haiku')
  const provider = getAPIProvider()
  const includeExperimentalBetas = shouldIncludeExperimentalBetas()
  if (!isHaiku) {
    betaHeaders.push(ZY_CODE_)
    if (isInternalBuild() && process.env.ZY_CODE_ENTRYPOINT === 'cli') {
      if (CLI_INTERNAL_BETA_HEADER) {
        betaHeaders.push(CLI_INTERNAL_BETA_HEADER)
      }
    }
  }
  if (!isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) && modelSupportsISP(model)) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Skip the API-side Haiku thinking summarizer — the summary is only used
  // for ctrl+o display, which interactive users rarely open. The API returns
  // redacted_thinking blocks instead; AssistantRedactedThinkingMessage already
  // renders those as a stub. SDK / print-mode keep summaries because callers
  // may iterate over thinking content. Users can opt back in via settings.json
  // showThinkingSummaries.
  if (
    includeExperimentalBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
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
  if (
    shouldIncludeExperimentalBetas() &&
    (antOptedIntoToolClearing || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // Add strict tool use beta if experiment is enabled.
  // Gate on includeExperimentalBetas: ZY_CODE_DISABLE_EXPERIMENTAL_BETAS
  // already strips schema.strict from tool bodies at api.ts's choke point, but
  // this header was escaping that kill switch. Proxy gateways that look like
  // anthropic but forward to Vertex reject this header with 400.
  // github.com/deshaw/anthropic-issues/issues/5
  const strictToolsEnabled = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_strict_tools')
  // 3P default: false. API rejects strict + token-efficient-tools together
  // (tool_use.py:139), so these are mutually exclusive — strict wins.
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled && getFeatureValue_CACHED_MAY_BE_STALE('zy_json_tools_beta', false)
  if (includeExperimentalBetas && modelSupportsStructuredOutputs(model) && strictToolsEnabled) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }
  // JSON tool_use format (FC v3) — ~4.5% output token reduction vs ANTML.
  // Sends the v2 header (2026-03-28) added in anthropics/anthropic#337072 to
  // isolate the CC A/B cohort from ~9.2M/week existing v1 senders. Ant-only
  // while the restored JsonToolUseOutputParser soaks.
  if (isInternalBuild() && includeExperimentalBetas && tokenEfficientToolsEnabled) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  // Add web search beta for Vertex Zy 4.0+ models only
  if (provider === 'vertex' && vertexModelSupportsWebSearch(model)) {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }
  // Foundry only ships models that already support Web Search
  if (provider === 'foundry') {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }

  // Always send the beta header for direct API. The header is a no-op without a scope field.
  if (includeExperimentalBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
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

  // Agentic queries always need zy-code and cli-internal beta headers.
  // For non-Haiku models these are already in baseBetas; for Haiku they're
  // excluded by getAllModelBetas() since non-agentic Haiku calls don't need them.
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(ZY_CODE_)) {
      baseBetas.push(ZY_CODE_)
    }
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
