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

// Standard pricing tier for Sonnet models: ¥3 input / ¥15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: ¥0.80 input / ¥4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: ¥1 input / ¥5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

/** Back-compat shim — was Opus 4.6 specific, now returns generic high-cost tier */
export function getOpus46CostTier(): ModelCosts {
  return {
    inputTokens: 5,
    outputTokens: 25,
    promptCacheWriteTokens: 6.25,
    promptCacheReadTokens: 0.5,
    webSearchRequests: 0.01,
  } as const satisfies ModelCosts
}

/**
 * Resolve costs for a model. Falls back to the default model's costs if unknown.
 * 对于阶梯费用模型，usage.input_tokens 用于确定当前所在阶梯。
 */
export function getModelCosts(model: string, usage: Usage): ModelCosts {
  // 传入当前累计输入 token 总量，用于阶梯费用定价
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

  // Try default model
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

  // Absolute fallback
  trackUnknownModelCost(model)
  return COST_TIER_3_15
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

function formatPrice(price: number): string {
  const symbol = getCurrencySymbol()
  if (Number.isInteger(price)) {
    return `${symbol}${price}`
  }
  return `${symbol}${price.toFixed(2)}`
}

/**
 * 将模型定价格式化为字符串展示
 * 例如：中文 "¥5/¥25 per Mtok"，英文 "$5/$25 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const pricing = getStaticPricingForModel(model)
  if (!pricing) return undefined
  return formatModelPricing({
    inputTokens: pricing.cost_input,
    outputTokens: pricing.cost_output,
    promptCacheWriteTokens: pricing.cost_cache_write,
    promptCacheReadTokens: pricing.cost_cache_read,
    webSearchRequests: pricing.cost_web_search,
  })
}
