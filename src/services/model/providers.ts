import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import {
  getLocalModelCapability,
  getLocalModelCosts,
  localModelHasCapability,
  parseTokenCount,
} from '../../utils/settings/localModelCapabilities.js'
import { type OpenAICompat, getProviderEntry, PROVIDER_REGISTRY } from './providerRegistry.js'

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
 * Provider 级别的能力声明 —— 在 providerRegistry.ts 中按 provider 定义，
 * 可按模型进行细化。
 *
 * 添加新 provider 时，请修改 providerRegistry.ts 而非此文件。
 */
// 注:effort（思考强度）能力已从布尔标记升级为档位列表,
// 见 ProviderEntry.defaultEffortLevels / model-capabilities.json 的 effortLevels。
// 此处不再有 'effort' / 'max_effort' 布尔能力。
export type ProviderCapability =
  | 'thinking' // 扩展思考（thinking blocks）
  | 'adaptive_thinking' // 自适应思考模式
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
 * 双格式 provider（如 dashscope）通过 settings.apiFormat 切换。
 */
export function isOpenAIProvider(provider: APIProvider): boolean {
  const entry = getProviderEntry(provider)
  if (!entry) return false
  const supportsOpenAI = entry.supportedFormats.includes('openai')
  const supportsAnthropic = entry.supportedFormats.includes('anthropic')
  if (!supportsAnthropic) return supportsOpenAI
  if (!supportsOpenAI) return false
  // 双格式：读取用户设置，默认 openai
  const { getInitialSettings } = require('../../utils/settings/settings.js')
  return (getInitialSettings()?.apiFormat ?? 'openai') === 'openai'
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

/**
 * 获取 provider 的 OpenAI 兼容协议差异声明。
 * 消息转换层通过此配置决定行为，而非判断 provider 名称。
 */
export function getProviderCompat(provider?: string): OpenAICompat | undefined {
  const entry = getProviderEntry(provider ?? getAPIProvider())
  return entry?.openaiCompat
}

/**
 * 获取 provider 的 effort 映射表（内部档位 → API 参数值）。
 * 未声明时返回 undefined，调用方应回退到 anthropic 映射。
 */
export function getProviderEffortMapping(provider?: string): Record<string, string> | undefined {
  const entry = getProviderEntry(provider ?? getAPIProvider())
  return entry?.effortMapping
}
