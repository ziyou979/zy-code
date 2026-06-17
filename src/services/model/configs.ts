import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

/** Provider-aware model ID mapping for qwen3.6-plus. */
export const QWEN_3_6_PLUS_MODEL_CONFIG: ModelConfig = {
  anthropic: 'qwen3.6-plus',
  bedrock: 'qwen3.6-plus',
  vertex: 'qwen3.6-plus',
  foundry: 'qwen3.6-plus',
  dashscope: 'qwen3.6-plus',
  openrouter: 'qwen/qwen3.6-plus',
  generic: 'qwen3.6-plus',
  local: 'qwen3.6-plus',
  zhipu: 'qwen3.6-plus',
  kimi: 'qwen3.6-plus',
  openai: 'gpt-4o',
} as const

// @[MODEL LAUNCH]: Register the new provider-aware model ID mapping here.
export const ALL_MODEL_CONFIGS = {
  qwen36plus: QWEN_3_6_PLUS_MODEL_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical model IDs, e.g. 'qwen3.6-plus' */
export type CanonicalModelId = (typeof ALL_MODEL_CONFIGS)[ModelKey]['anthropic']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map((c) => c.anthropic) as [
  CanonicalModelId,
  ...CanonicalModelId[],
]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> = Object.fromEntries(
  (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(([key, cfg]) => [
    cfg.anthropic,
    key,
  ]),
) as Record<CanonicalModelId, ModelKey>
