import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/index.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import {
  getLocalModelApiFormat,
  getLocalModelCapability,
  getLocalModelCosts,
  parseTokenCount,
} from '../settings/localModelCapabilities.js'
import { getActiveOAuthProviderInfo } from '../oauth/oauthStorage.js'
import { type ApiFormat } from './apiFormat.js'
import {
  DEFAULT_OPENAI_THINKING_ATTR,
  getProviderEntry,
  type OpenAiAttr,
  PROVIDER_REGISTRY,
} from './providerRegistry.js'

/**
 * 所有已注册的 provider ID 的联合类型。
 * 派生自 PROVIDER_REGISTRY —— 添加新 provider 请修改该文件，而非此处。
 */
export type APIProvider = (typeof PROVIDER_REGISTRY)[number]['id']

/**
 * 从 settings（zy.json）中获取已配置的 API provider。
 * 未配置时返回 null。
 */
function getSettingsProvider(): APIProvider | null {
  try {
    const { getInitialSettings } =
      require('../settings/settings.js') as typeof import('../settings/settings.js')
    const settings = getInitialSettings()
    return settings?.provider ?? null
  } catch {
    return null
  }
}

/**
 * 从 onboarding 配置中获取已配置的 API provider。
 * 如果配置尚未就绪（启动早期）或未配置，则返回 null。
 */
function getConfiguredProvider(): APIProvider | null {
  try {
    const { getGlobalConfig } =
      require('../config/config.js') as typeof import('../config/config.js')
    return getGlobalConfig().configuredProvider ?? null
  } catch {
    // 配置尚未就绪 —— 返回 null 以继续检测环境变量
    return null
  }
}

export function getAPIProvider(): APIProvider {
  // 0. 优先检查多 Provider OAuth 登录的活跃 provider
  const oauthProvider = getActiveOAuthProviderInfo()
  if (oauthProvider?.apiProvider) {
    return oauthProvider.apiProvider as APIProvider
  }

  // 1. 检查 settings.json (zy.json) 中配置的平台
  const settingsProvider = getSettingsProvider()
  if (settingsProvider) {
    return settingsProvider
  }

  // 2. 检查 onboarding 时配置的平台
  const configured = getConfiguredProvider()
  if (configured) {
    return configured
  }

  // 3. 默认使用 anthropic
  return 'anthropic'
}

/**
 * 从 settings.json 中读取已配置的 baseUrl。
 * 返回 null 表示未配置，由调用方继续 fallback。
 */
export function getSettingsBaseUrl(provider?: string): string | null {
  try {
    const { getInitialSettings } =
      require('../settings/settings.js') as typeof import('../settings/settings.js')
    const settings = getInitialSettings()
    const providerId = provider ?? settings?.provider ?? null
    if (providerId) {
      const providerBaseUrl = settings?.providers?.[providerId]?.baseUrl
      if (providerBaseUrl) {
        return providerBaseUrl
      }
    }
    return settings?.baseUrl ?? null
  } catch {
    return null
  }
}

/**
 * 获取活跃 OAuth provider 的 API 消息格式。
 * 如果没有活跃的 OAuth provider，返回 null。
 */
export function getOAuthApiFormat(): ApiFormat | null {
  const oauthProvider = getActiveOAuthProviderInfo()
  if (!oauthProvider?.apiFormat) {
    return null
  }
  return oauthProvider.apiFormat
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 判断模型本身是否为真 Anthropic(Claude)模型——决定 anthropic-beta header 该不该发。
 *
 * 按 **model id** 识别(claude/sonnet/opus/haiku,兼容 `anthropic/`、`anthropic.` 前缀),
 * 而非按 provider:同一个 provider 既可能跑 Claude 也可能跑别家(openrouter 转 Claude、
 * 也转 Gemini;bedrock/vertex 同理),只有模型本身是 Claude 时这些 beta 才有意义。
 *
 * 这是「beta 语义上适用吗」这一维;「端点接不接受 beta」是另一维(见 toolSearch 的
 * Vertex / 代理 gate、ZY_CODE_DISABLE_EXPERIMENTAL_BETAS 逃生口)。
 */
export function isAnthropicModel(model: string): boolean {
  return /claude|sonnet|opus|haiku/i.test(model)
}

/**
 * Provider 级别的能力声明 —— 在 providerRegistry.ts 中按 provider 定义。
 *
 * 模型级能力（thinking、structured_outputs 等）在 ~/.zy/model-capabilities.json 中配置，
 * 见 localModelCapabilities.ts 的 ModelCapabilityKind。
 *
 * 添加新 provider 时，请修改 providerRegistry.ts 而非此文件。
 */
export type ProviderCapability = 'context_management' // 上下文管理 beta（Anthropic 特有，后续由框架层实现）

/** 按 provider 的能力声明 —— 从 PROVIDER_REGISTRY 自动生成。 */
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
 * 检查 ZY_CODE_BASE_URL 是否为 Anthropic API 地址。
 * 未设置（使用默认 API）或指向 api.anthropic.com 时返回 true
 * （内部构建还允许 api-staging.anthropic.com）。
 */
export function isAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ZY_CODE_BASE_URL
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
 * 对于直接使用 Anthropic SDK 并采用 Anthropic 兼容消息格式的 provider 返回 true
 * （不仅是使用了 SDK 库，而是请求/响应的实际结构也兼容）。
 * 用于 beta header 注入和 request-ID 日志记录。
 */
export function isCompatibleProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  if (!entry) {
    return false
  }
  // bedrock、vertex、azure 使用 Anthropic 格式但不走 Anthropic SDK
  return !['bedrock', 'vertex', 'azure'].includes(entry.id)
}

/**
 * 返回 provider 当前实际生效的 API 消息格式。
 *
 * 优先级：
 * 1. 模型在 `model-capabilities.json` 中声明的 `apiFormat`（若 provider 支持）
 * 2. provider 注册表中的模型级 apiFormat 路由（若 provider 支持）
 * 3. 活跃 OAuth provider 声明的 apiFormat（若与当前 provider 匹配）
 * 4. 用户显式设置的 `settings.apiFormat`（若 provider 支持）
 * 5. provider 注册表声明的 `supportedFormats[0]`（默认首选格式）
 *
 * 若 provider 不存在或不支持任何格式，返回 null。
 */
export function getEffectiveApiFormat(provider: APIProvider, model?: string): ApiFormat | null {
  const entry = getProviderEntry(provider)
  if (!entry || entry.supportedFormats.length === 0) {
    return null
  }

  const supported = new Set(entry.supportedFormats)

  // 1. 模型级声明优先，用于同一 provider 下不同模型走不同 API 格式。
  if (model) {
    const modelApiFormat = getLocalModelApiFormat(model, { provider })
    if (modelApiFormat && supported.has(modelApiFormat)) {
      return modelApiFormat
    }

    const normalizedModel = model.toLowerCase()
    const registryModelApiFormat = entry.modelApiFormats
      ?.slice()
      .sort((a, b) => b.pattern.length - a.pattern.length)
      .find(({ pattern }) => normalizedModel.includes(pattern.toLowerCase()))?.apiFormat
    if (registryModelApiFormat && supported.has(registryModelApiFormat)) {
      return registryModelApiFormat
    }
  }

  // 3. OAuth provider 自带格式优先于全局 settings，避免登录源被全局配置误伤。
  const oauthProvider = getActiveOAuthProviderInfo()
  if (
    oauthProvider?.apiProvider === provider &&
    oauthProvider.apiFormat &&
    supported.has(oauthProvider.apiFormat)
  ) {
    return oauthProvider.apiFormat
  }

  // 4. 用户显式设置优先
  try {
    const { getInitialSettings } =
      require('../settings/settings.js') as typeof import('../settings/settings.js')
    const settings = getInitialSettings()
    const format = settings.providers?.[provider]?.apiFormat ?? settings.apiFormat
    if (format && supported.has(format)) {
      return format
    }
  } catch {
    // settings 尚未就绪，继续按默认值推导
  }

  // 5. 默认使用注册表中声明的第一个格式
  return entry.supportedFormats[0]
}

/**
 * 判断是否为使用 OpenAI SDK 直连的 provider。
 * 双格式 provider（如 dashscope）通过 settings.apiFormat 切换。
 */
export function isOpenAIProvider(provider: APIProvider, model?: string): boolean {
  return getEffectiveApiFormat(provider, model) === 'openai'
}

/**
 * 判断是否为使用 Google Generative AI 原生 API 的 provider。
 * Gemini 默认使用 google 格式，可通过 settings.apiFormat 切换回 openai。
 */
export function isGoogleProvider(provider: APIProvider, model?: string): boolean {
  return getEffectiveApiFormat(provider, model) === 'google'
}

/**
 * 判断是否为使用 Anthropic SDK / Anthropic 兼容消息格式的 provider。
 * 双格式 provider（如 dashscope）通过 settings.apiFormat 切换为 openai 时返回 false。
 */
export function isAnthropicProvider(provider: APIProvider, model?: string): boolean {
  return getEffectiveApiFormat(provider, model) === 'anthropic'
}

/**
 * 判断是否为需要自定义端点配置的 provider（本地推理引擎等）。
 * 这类 provider 使用用户提供的 base URL。
 */
export function isCustomEndpointProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.endpointType.includes('custom') === true && entry.id !== 'generic'
}

/**
 * 判断是否为支持环境变量覆盖 base URL 的 provider。
 */
export function isEnvEndpointProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  return entry?.endpointType.includes('env') === true
}

export function getModelMaxInputTokens(model: string): number | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.tokens?.maxInputTokens) {
    return undefined
  }
  return parseTokenCount(entry.tokens.maxInputTokens)
}

export function getModelCostsFromSettings(
  model: string,
  currentInputTokens?: number,
  provider?: APIProvider,
):
  | {
      inputTokens: number
      outputTokens: number
      promptCacheWriteTokens: number
      promptCacheReadTokens: number
      webSearchRequests: number
      currency: string
    }
  | undefined {
  return getLocalModelCosts(
    model,
    currentInputTokens,
    provider
      ? {
          provider,
          apiFormat: getEffectiveApiFormat(provider, model),
        }
      : undefined,
  )
}

/**
 * 获取 provider 的 OpenAI 兼容协议扩展属性。
 * 消息转换层通过此配置决定行为，而非判断 provider 名称。
 */
export function getProviderAttr(provider?: string, model?: string): OpenAiAttr | undefined {
  const providerId = provider ?? getAPIProvider()
  const entry = getProviderEntry(providerId)
  if (!entry) {
    return undefined
  }

  // OpenAI 格式统一具备默认 thinking 映射；provider 可按需覆盖。
  if (getEffectiveApiFormat(providerId as APIProvider, model) === 'openai') {
    return {
      ...entry.openaiAttr,
      thinking: {
        ...DEFAULT_OPENAI_THINKING_ATTR,
        ...(entry.openaiAttr?.thinking ?? {}),
      },
    }
  }

  return entry.openaiAttr
}
