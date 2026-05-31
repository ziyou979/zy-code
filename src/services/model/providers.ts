import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import {
  getLocalModelCapability,
  getLocalModelCosts,
  localModelHasCapability,
  parseTokenCount,
} from '../../utils/settings/localModelCapabilities.js'
import { getProviderEntry, PROVIDER_REGISTRY } from './providerRegistry.js'

/**
 * 所有已注册的 provider ID 的联合类型。
 * 派生自 PROVIDER_REGISTRY —— 添加新 provider 请修改该文件，而非此处。
 */
export type APIProvider = (typeof PROVIDER_REGISTRY)[number]['id']

/**
 * 从 settings（zy.json）中获取已配置的 API provider。
 * 未配置时返回 null。
 */
function getSettingsProvider(): Exclude<APIProvider, 'bedrock' | 'vertex' | 'foundry'> | null {
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
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
function getConfiguredProvider(): Exclude<APIProvider, 'bedrock' | 'vertex' | 'foundry'> | null {
  try {
    const { getGlobalConfig } =
      require('../../utils/config.js') as typeof import('../../utils/config.js')
    return getGlobalConfig().configuredProvider ?? null
  } catch {
    // 配置尚未就绪 —— 返回 null 以继续检测环境变量
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

  // 3. 检查注册表中的激活环境变量
  for (const entry of PROVIDER_REGISTRY) {
    if (entry.activationEnvVar && isEnvTruthy(process.env[entry.activationEnvVar])) {
      return entry.id as APIProvider
    }
  }

  // 4. 默认使用 anthropic
  return 'anthropic'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 服务真实 Anthropic(Claude)模型的 provider —— 只有它们才认 `anthropic-beta`
 * header。三方聚合端(dashscope/zhipu/kimi/openrouter/…)只是说 anthropic *格式*,
 * 并不识别这些 beta,发过去有 400 `Unsupported beta header` 的风险,故排除。
 */
const ANTHROPIC_MODEL_PROVIDERS: ReadonlySet<APIProvider> = new Set<APIProvider>([
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
])

/** 仅当当前 provider 服务真实 Claude 模型时为 true(见上)。 */
export function isAnthropicModelProvider(): boolean {
  return ANTHROPIC_MODEL_PROVIDERS.has(getAPIProvider())
}

/**
 * Provider 级别的能力声明 —— 在 providerRegistry.ts 中按 provider 定义，
 * 可按模型进行细化。
 *
 * 添加新 provider 时，请修改 providerRegistry.ts 而非此文件。
 */
export type ProviderCapability =
  | 'thinking' // 扩展思考（thinking blocks）
  | 'adaptive_thinking' // 自适应思考模式
  | 'effort' // effort 参数（low/medium/high/max）
  | 'max_effort' // 支持最大 effort 级别
  | 'advisor' // advisor 工具支持
  | 'structured_outputs' // 严格工具 schema / 结构化输出 beta
  | 'context_management' // 上下文管理 beta（思考保留）
  | 'prompt_caching' // cache_control / prompt 缓存 beta
  | 'web_search' // 网络搜索工具
  | 'interleaved_thinking' // 交错思考（ISP）beta

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
 * 检查 ANTHROPIC_BASE_URL 是否为 Anthropic API 地址。
 * 未设置（使用默认 API）或指向 api.anthropic.com 时返回 true
 * （内部构建还允许 api-staging.anthropic.com）。
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
 * 对于直接使用 Anthropic SDK 并采用 Anthropic 兼容消息格式的 provider 返回 true
 * （不仅是使用了 SDK 库，而是请求/响应的实际结构也兼容）。
 * 用于 beta header 注入和 request-ID 日志记录。
 */
export function isCompatibleProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  if (!entry) {
    return false
  }
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
 * 用法：用 `modelHasCapability(model, 'thinking')` 替代硬编码的模型判断。
 */
export function modelHasCapability(
  model: string,
  capability: ProviderCapability | 'auto_mode',
): boolean {
  if (localModelHasCapability(model, capability)) {
    return true
  }
  return providerHasCapability(getAPIProvider(), capability as ProviderCapability)
}

export function getModelMaxInputTokens(model: string): number | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxInputTokens) {
    return undefined
  }
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
