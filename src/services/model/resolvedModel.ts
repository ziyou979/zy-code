// 模型信息值对象 —— 在模型选择时一次性解析所有信息，后续流程只传该对象。
// 消除对全局状态（settings、env、缓存文件）的反复查询。

import { getMaxOutputTokensForModel } from '../api/apiHelpers.js'
import { getContextWindowForModel, getMaxThinkingTokensForModel } from '../../utils/context.js'
import { modelSupportsEffort } from '../../utils/effort.js'
import { modelSupportsAdaptiveThinking, modelSupportsThinking } from '../../utils/thinking.js'
import { type APIProvider, getAPIProvider, isAnthropicModel } from './providers.js'
import { normalizeModelStringForAPI } from './model.js'
import { type OpenAICompat, getProviderEntry } from './providerRegistry.js'

export interface ResolvedModel {
  /** 原始模型名（用户指定） */
  id: string
  /** 规范化后的 API 模型名（移除 [1m] 等后缀） */
  apiModelId: string
  /** 解析后的 provider */
  provider: APIProvider
  /** 是否支持 thinking */
  supportsThinking: boolean
  /** 是否支持自适应 thinking */
  supportsAdaptiveThinking: boolean
  /** 是否支持 effort 档位 */
  supportsEffort: boolean
  /** 最大输出 token 数 */
  maxOutputTokens: number
  /** 最大思考 token 数 */
  maxThinkingTokens: number
  /** 上下文窗口大小 */
  contextWindow: number
  /** OpenAI 兼容协议差异配置 */
  openaiCompat?: OpenAICompat
  /** effort 档位→API 参数值映射 */
  effortMapping?: Record<string, string>
  /** 是否为 Anthropic 模型（影响 beta header、effort 参数格式等） */
  isAnthropic: boolean
}

/**
 * 一次性解析模型的所有信息。
 * 优先级链：model-capabilities.json → API error 运行时降级 → provider 注册表 → 默认值。
 */
export function resolveModel(modelName: string): ResolvedModel {
  const provider = getAPIProvider()
  const entry = getProviderEntry(provider)

  return {
    id: modelName,
    apiModelId: normalizeModelStringForAPI(modelName),
    provider,
    supportsThinking: modelSupportsThinking(modelName),
    supportsAdaptiveThinking: modelSupportsAdaptiveThinking(modelName),
    supportsEffort: modelSupportsEffort(modelName),
    maxOutputTokens: getMaxOutputTokensForModel(modelName),
    maxThinkingTokens: getMaxThinkingTokensForModel(modelName),
    contextWindow: getContextWindowForModel(modelName),
    openaiCompat: entry?.openaiCompat,
    effortMapping: entry?.effortMapping,
    isAnthropic: isAnthropicModel(modelName),
  }
}
