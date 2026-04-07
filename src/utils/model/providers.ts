import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'dashscope' | 'openrouter' | 'generic' | 'ollama' | 'zhipu' | 'kimi'

/**
 * Get the configured API provider from settings (zy.json).
 * Returns null if not configured in settings.
 */
function getSettingsProvider(): 'anthropic' | 'dashscope' | 'openrouter' | 'generic' | 'ollama' | 'zhipu' | 'kimi' | null {
  try {
    const { getSettings_DEPRECATED } = require('../settings/settings.js') as typeof import('../settings/settings.js')
    const settings = getSettings_DEPRECATED()
    return settings?.provider ?? null
  } catch {
    return null
  }
}

/**
 * Get the configured API provider from onboarding config.
 * Returns null if config isn't ready yet (early startup) or not configured.
 */
function getConfiguredProvider(): 'anthropic' | 'dashscope' | 'openrouter' | 'generic' | 'ollama' | 'zhipu' | 'kimi' | null {
  try {
    const { getGlobalConfig } = require('../config.js') as typeof import('../config.js')
    return getGlobalConfig().configuredProvider ?? null
  } catch {
    // Config not ready yet — return null to fall through to env var detection
    return null
  }
}

export function getAPIProvider(): APIProvider {
  // 1. 优先检查 settings.json (zy.json) 中配置的平台
  const settingsProvider = getSettingsProvider()
  if (settingsProvider) {
    return settingsProvider
  }

  // 2. 检查 onboarding 时配置的平台
  const configured = getConfiguredProvider()
  if (configured) {
    return configured
  }

  // 百炼 / DashScope API
  if (isEnvTruthy(process.env.ZY_CODE_USE_DASHSCOPE)) {
    return 'dashscope'
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_OPENROUTER)) {
    return 'openrouter'
  }
  // Generic Anthropic-compatible endpoint
  if (process.env.ZY_CODE_USE_GENERIC) {
    return 'generic'
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_OLLAMA)) {
    return 'ollama'
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_ZHIPU)) {
    return 'zhipu'
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_KIMI)) {
    return 'kimi'
  }
  return isEnvTruthy(process.env.ZY_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.ZY_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.ZY_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'anthropic'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Provider-level capabilities — declared per-provider, optionally refined per-model.
 * A capability being `true` here means the provider *can* support it; the final
 * decision for a specific model may still depend on the model itself (handled
 * by the per-model check functions in thinking.ts / effort.ts / betas.ts).
 *
 * When adding a new provider, update its capabilities here instead of adding
 * another `=== 'anthropic'` gate across the codebase.
 */
export type ProviderCapability =
  | 'thinking'            // extended thinking (thinking blocks)
  | 'adaptive_thinking'   // adaptive thinking mode
  | 'effort'              // effort parameter (low/medium/high/max)
  | 'structured_outputs'  // strict tool schema / structured outputs beta
  | 'context_management'  // context management beta (thinking preservation)
  | 'prompt_caching'      // cache_control / prompt caching beta
  | 'web_search'          // web search tool
  | 'interleaved_thinking' // interleaved thinking (ISP) beta

/** Per-provider capability declarations. Defaults to false. */
const PROVIDER_CAPABILITIES: Record<APIProvider, Set<ProviderCapability>> = {
  anthropic: new Set<ProviderCapability>([
    'thinking', 'adaptive_thinking', 'effort', 'structured_outputs',
    'context_management', 'prompt_caching', 'web_search', 'interleaved_thinking',
  ]),
  dashscope: new Set<ProviderCapability>([
    // DashScope models support all capabilities; disable prompt_caching since
    // the DashScope Anthropic-compatible endpoint does not accept cache_control
    'thinking', 'adaptive_thinking', 'effort', 'structured_outputs',
    'context_management', 'web_search', 'interleaved_thinking',
  ]),
  openrouter: new Set<ProviderCapability>([
    // OpenRouter forwards Anthropic-format responses; capabilities depend on
    // the underlying model. We declare support here and let per-model checks
    // handle the fine-grained decisions.
    'thinking', 'adaptive_thinking', 'effort', 'structured_outputs',
    'context_management', 'web_search', 'interleaved_thinking',
  ]),
  generic: new Set<ProviderCapability>([
    // Generic Anthropic-compatible endpoint — assume full capability.
    'thinking', 'adaptive_thinking', 'effort', 'structured_outputs',
    'context_management', 'prompt_caching', 'web_search', 'interleaved_thinking',
  ]),
  ollama: new Set<ProviderCapability>([
    // Ollama uses OpenAI-compatible API; capabilities depend on the
    // underlying model loaded locally.
    'thinking', 'adaptive_thinking', 'structured_outputs',
    'context_management', 'web_search', 'interleaved_thinking',
  ]),
  zhipu: new Set<ProviderCapability>([
    // ZhiPu (GLM) uses OpenAI-compatible API; capabilities depend on model.
    'thinking', 'structured_outputs', 'context_management', 'web_search',
  ]),
  kimi: new Set<ProviderCapability>([
    // Kimi (Moonshot) uses OpenAI-compatible API; capabilities depend on model.
    'thinking', 'structured_outputs', 'context_management', 'web_search',
  ]),
  foundry: new Set<ProviderCapability>([
    'thinking', 'structured_outputs', 'context_management', 'web_search', 'interleaved_thinking',
  ]),
  bedrock: new Set<ProviderCapability>([
    'prompt_caching',
  ]),
  vertex: new Set<ProviderCapability>([
    'prompt_caching',
  ]),
}

export function providerHasCapability(
  provider: APIProvider,
  capability: ProviderCapability,
): boolean {
  return PROVIDER_CAPABILITIES[provider]?.has(capability) ?? false
}

/**
 * Check if ANTHROPIC_BASE_URL is an Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'zy-super') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

/**
 * Returns true for providers that use the Anthropic SDK directly with an
 * Anthropic-compatible message format (not just the SDK library, but the
 * actual request/response shape). Used for beta header injection and
 * request-ID logging.
 */
export function isCompatibleProvider(provider: APIProvider): boolean {
  return provider === 'anthropic' || provider === 'dashscope' || provider === 'openrouter' || provider === 'generic' || provider === 'ollama' || provider === 'zhipu' || provider === 'kimi'
}

/** OpenAI-compatible API format providers (use standard messages.create, no betas) */
export type OpenAIFormatProvider = 'dashscope'

/**
 * Returns true for providers that use an OpenAI-compatible API format
 * (translated through the Anthropic SDK). These providers do NOT support
 * Anthropic-specific beta features like extended thinking, cache_control,
 * context_management, etc.
 */
export function isOpenAIFormatProvider(provider: APIProvider): provider is OpenAIFormatProvider {
  return provider === 'dashscope'
}

/** Providers that require custom endpoint configuration (base URL) but support full Anthropic format */
export type CustomEndpointProvider = 'ollama' | 'zhipu' | 'kimi'

/**
 * Returns true for providers that require custom endpoint configuration
 * (custom base URL) but otherwise support the full Anthropic message format.
 */
export function isCustomEndpointProvider(provider: APIProvider): provider is CustomEndpointProvider {
  return provider === 'ollama' || provider === 'zhipu' || provider === 'kimi'
}

/**
 * Model capability — resolved from settings.json `modelCapabilities`.
 * Settings take priority over hardcoded provider-level declarations.
 *
 * Usage: replace hardcoded model checks with
 * `modelHasCapability(model, 'thinking')`.
 */
export function modelHasCapability(
  model: string,
  capability: ProviderCapability | '1m_context' | 'auto_mode',
): boolean {
  const settings = readSettings()
  if (settings?.modelCapabilities) {
    const m = model.toLowerCase()
    for (const mc of settings.modelCapabilities) {
      if (m.includes(mc.model.toLowerCase())) {
        if (mc.capabilities.includes(capability as never)) return true
      }
    }
  }
  return providerHasCapability(getAPIProvider(), capability as ProviderCapability)
}

export function getModelMaxInputTokens(model: string): number | undefined {
  const settings = readSettings()
  if (settings?.modelCapabilities) {
    const m = model.toLowerCase()
    for (const mc of settings.modelCapabilities) {
      if (m.includes(mc.model.toLowerCase())) {
        return mc.maxInputTokens
      }
    }
  }
  return undefined
}

export function getModelCostsFromSettings(model: string): {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
} | undefined {
  const settings = readSettings()
  if (settings?.modelCapabilities) {
    const m = model.toLowerCase()
    for (const mc of settings.modelCapabilities) {
      if (m.includes(mc.model.toLowerCase())) {
        if (mc.costs) {
          return {
            inputTokens: mc.costs.inputTokens,
            outputTokens: mc.costs.outputTokens,
            promptCacheWriteTokens: mc.costs.promptCacheWriteTokens ?? 0,
            promptCacheReadTokens: mc.costs.promptCacheReadTokens ?? 0,
            webSearchRequests: mc.costs.webSearchRequests ?? 0,
          }
        }
      }
    }
  }
  return undefined
}

function readSettings(): {
  modelCapabilities?: Array<{
    model: string
    capabilities: string[]
    maxInputTokens?: number
    costs?: {
      inputTokens: number
      outputTokens: number
      promptCacheWriteTokens?: number
      promptCacheReadTokens?: number
      webSearchRequests?: number
    }
  }>
} | null {
  try {
    const { getSettings_DEPRECATED } = require('../settings/settings.js')
    return getSettings_DEPRECATED()
  } catch {
    return null
  }
}
