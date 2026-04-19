import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

/** Pricing per million tokens: input / output / cache_write / cache_read / web_search */
export type ModelPricing = {
  /** Cost per million input tokens (CNY) */
  inputTokens: number
  /** Cost per million output tokens (CNY) */
  outputTokens: number
  /** Cost per million prompt cache write tokens (CNY) */
  promptCacheWriteTokens: number
  /** Cost per million prompt cache read tokens (CNY) */
  promptCacheReadTokens: number
  /** Cost per web search request (CNY) */
  webSearchRequests: number
}

export type ModelConfigWithPricing = {
  config: ModelConfig
  costs: ModelPricing
}

export const QWEN_3_6_PLUS_CONFIG: ModelConfigWithPricing = {
  config: {
    anthropic: 'qwen3.6-plus',
    bedrock: 'qwen3.6-plus',
    vertex: 'qwen3.6-plus',
    foundry: 'qwen3.6-plus',
    dashscope: 'qwen3.6-plus',
    openrouter: 'qwen/qwen3.6-plus',
    generic: 'qwen3.6-plus',
    ollama: 'qwen3.6-plus',
    zhipu: 'qwen3.6-plus',
    kimi: 'qwen3.6-plus',
    openai: 'gpt-4o',
  },
  costs: {
    inputTokens: 5,
    outputTokens: 25,
    promptCacheWriteTokens: 6.25,
    promptCacheReadTokens: 0.5,
    webSearchRequests: 0.01,
  },
} as const

// @[MODEL LAUNCH]: Register the new config here with pricing.
export const ALL_MODEL_CONFIGS_WITH_COSTS = {
  qwen36plus: QWEN_3_6_PLUS_CONFIG,
} as const satisfies Record<string, ModelConfigWithPricing>

/** Back-compat: the raw ModelConfig map (without costs) */
export const ALL_MODEL_CONFIGS = {
  qwen36plus: QWEN_3_6_PLUS_CONFIG.config,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS_WITH_COSTS

/** Union of all canonical model IDs, e.g. 'qwen3.6-plus' */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['anthropic']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.anthropic,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.anthropic, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
