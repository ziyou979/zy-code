import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { isInternalBuild } from '../envUtils.js'
import {
  localModelHasCapability,
  getLocalModelCapability,
  getLocalModelCosts,
  parseTokenCount,
} from '../settings/localModelCapabilities.js'
import { PROVIDER_REGISTRY, getProviderEntry } from './providerRegistry.js'

/**
 * Union of all registered provider IDs.
 * Derived from PROVIDER_REGISTRY — add new providers there, not here.
 */
export type APIProvider = (typeof PROVIDER_REGISTRY)[number]['id']

/**
 * Get the configured API provider from settings (zy.json).
 * Returns null if not configured in settings.
 */
function getSettingsProvider(): Exclude<APIProvider, 'bedrock' | 'vertex' | 'foundry'> | null {
  try {
    const { getSettings_DEPRECATED } =
      require('../settings/settings.js') as typeof import('../settings/settings.js')
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
function getConfiguredProvider(): Exclude<APIProvider, 'bedrock' | 'vertex' | 'foundry'> | null {
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

  // 3. Check activation env vars from registry
  for (const entry of PROVIDER_REGISTRY) {
    if (entry.activationEnvVar && isEnvTruthy(process.env[entry.activationEnvVar])) {
      return entry.id as APIProvider
    }
  }

  // 4. Default to anthropic
  return 'anthropic'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Provider-level capabilities — declared per-provider in providerRegistry.ts,
 * optionally refined per-model.
 *
 * When adding a new provider, update providerRegistry.ts instead of this file.
 */
export type ProviderCapability =
  | 'thinking' // extended thinking (thinking blocks)
  | 'adaptive_thinking' // adaptive thinking mode
  | 'effort' // effort parameter (low/medium/high/max)
  | 'max_effort' // max effort level support
  | 'advisor' // advisor tool support
  | 'structured_outputs' // strict tool schema / structured outputs beta
  | 'context_management' // context management beta (thinking preservation)
  | 'prompt_caching' // cache_control / prompt caching beta
  | 'web_search' // web search tool
  | 'interleaved_thinking' // interleaved thinking (ISP) beta

/** Per-provider capability declarations — auto-generated from PROVIDER_REGISTRY. */
const PROVIDER_CAPABILITIES: Record<string, Set<ProviderCapability>> = Object.fromEntries(
  PROVIDER_REGISTRY.map((entry) => [entry.id, new Set<ProviderCapability>(entry.capabilities)]),
)

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
    if (isInternalBuild()) {
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
  const entry = getProviderEntry(provider)
  if (!entry) return false
  return entry.endpointType !== 'hardcoded' || !['bedrock', 'vertex', 'foundry'].includes(entry.id)
}

/**
 * 判断是否为使用 OpenAI SDK 直连的 provider。
 * 这类 provider 不走 Anthropic SDK，而是直接使用 OpenAI 的 chat completions API。
 */
export function isOpenAIProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.supportedFormats.includes('openai') ?? false
}

/**
 * 判断是否为需要自定义端点配置的 provider（本地推理引擎等）。
 * 这类 provider 使用用户提供的 base URL。
 */
export function isCustomEndpointProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.endpointType === 'custom' && entry.id !== 'generic'
}

/**
 * 判断是否为在 onboarding 时预配置 base URL 的 provider。
 * 这类 provider 的 base URL 会在 onboarding 时保存到 configuredBaseUrl。
 */
export function isPreconfiguredEndpointProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.endpointType === 'preconfigured'
}

/**
 * 判断是否为从环境变量或默认值解析 base URL 的 provider。
 * 这类 provider 有专门的客户端创建逻辑。
 */
export function isEnvOrDefaultProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.endpointType === 'env-or-default'
}

/**
 * 从 ~/.zy/model-capabilities.json 读取模型能力配置。
 * 模型能力配置已从 settings.json 独立出来。
 *
 * Usage: replace hardcoded model checks with
 * `modelHasCapability(model, 'thinking')`.
 */
export function modelHasCapability(
  model: string,
  capability: ProviderCapability | 'auto_mode',
): boolean {
  if (localModelHasCapability(model, capability)) return true
  return providerHasCapability(getAPIProvider(), capability as ProviderCapability)
}

export function getModelMaxInputTokens(model: string): number | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxInputTokens) return undefined
  return parseTokenCount(entry.maxInputTokens)
}

export function getModelCostsFromSettings(
  model: string,
  currentInputTokens?: number,
):
  | {
      inputTokens: number
      outputTokens: number
      promptCacheWriteTokens: number
      promptCacheReadTokens: number
      webSearchRequests: number
    }
  | undefined {
  return getLocalModelCosts(model, currentInputTokens)
}
