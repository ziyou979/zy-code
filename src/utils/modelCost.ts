import type { TokenUsage as Usage } from '../types/llm.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { getUiLanguage } from '../i18n/index.js'
import {
  getStaticPricingForModel,
} from './model/modelCapabilities.js'
import {
  getDefaultMainLoopModelSetting,
} from './model/model.js'

export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

/**
 * 解析模型的定价。
 * 优先从 model-capabilities.json 读取，未配置则回退到默认模型定价。
 * 对于阶梯费用模型，usage.input_tokens 用于确定当前所在阶梯。
 */
export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const currentInput = (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.input_tokens
  const pricing = getStaticPricingForModel(model, currentInput)
  if (pricing) {
    return {
      inputTokens: pricing.cost_input,
      outputTokens: pricing.cost_output,
      promptCacheWriteTokens: pricing.cost_cache_write,
      promptCacheReadTokens: pricing.cost_cache_read,
      webSearchRequests: pricing.cost_web_search,
    }
  }

  const defaultModel = getDefaultMainLoopModelSetting()
  const defaultPricing = getStaticPricingForModel(defaultModel)
  if (defaultPricing) {
    return {
      inputTokens: defaultPricing.cost_input,
      outputTokens: defaultPricing.cost_output,
      promptCacheWriteTokens: defaultPricing.cost_cache_write,
      promptCacheReadTokens: defaultPricing.cost_cache_read,
      webSearchRequests: defaultPricing.cost_web_search,
    }
  }

  trackUnknownModelCost(model)
  // 无定价信息时返回零费用
  return {
    inputTokens: 0,
    outputTokens: 0,
    promptCacheWriteTokens: 0,
    promptCacheReadTokens: 0,
    webSearchRequests: 0,
  }
}

function trackUnknownModelCost(model: string): void {
  logEvent('zy_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

/**
 * 根据当前 UI 语言返回货币符号。
 * 中文 → ¥（人民币），其他 → $（美元）。
 * 注意：配置中的单价单位始终是 RMB（元/百万token），
 * 此函数仅影响展示层的符号，不影响内部数值计算。
 */
export function getCurrencySymbol(): string {
  const lang = getUiLanguage()
  return lang === 'zh-CN' ? '￥' : '$'
}

/**
 * 根据 token 用量和模型定价配置计算费用。
 * 返回值单位与配置中的单价单位一致（RMB 元）。
 */
function calculateTokenCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    ((usage as any).server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

/**
 * 计算单次请求的费用。
 * 返回值单位与配置中的单价单位一致（RMB 元）。
 */
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return calculateTokenCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

