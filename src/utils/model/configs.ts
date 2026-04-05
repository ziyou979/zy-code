import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  anthropic: 'zy-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.zy-3-7-sonnet-20250219-v1:0',
  vertex: 'zy-3-7-sonnet@20250219',
  foundry: 'zy-3-7-sonnet',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-3.7-sonnet',
  generic: 'zy-3-7-sonnet-20250219',
  ollama: 'zy-3-7-sonnet-20250219',
  zhipu: 'zy-3-7-sonnet-20250219',
  kimi: 'zy-3-7-sonnet-20250219',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  anthropic: 'zy-3-5-sonnet-20241022',
  bedrock: 'anthropic.zy-3-5-sonnet-20241022-v2:0',
  vertex: 'zy-3-5-sonnet-v2@20241022',
  foundry: 'zy-3-5-sonnet',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-3.5-sonnet',
  generic: 'zy-3-5-sonnet-20241022',
  ollama: 'zy-3-5-sonnet-20241022',
  zhipu: 'zy-3-5-sonnet-20241022',
  kimi: 'zy-3-5-sonnet-20241022',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  anthropic: 'zy-3-5-haiku-20241022',
  bedrock: 'us.anthropic.zy-3-5-haiku-20241022-v1:0',
  vertex: 'zy-3-5-haiku@20241022',
  foundry: 'zy-3-5-haiku',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-3.5-haiku',
  generic: 'zy-3-5-haiku-20241022',
  ollama: 'zy-3-5-haiku-20241022',
  zhipu: 'zy-3-5-haiku-20241022',
  kimi: 'zy-3-5-haiku-20241022',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  anthropic: 'zy-haiku-4-5-20251022',
  bedrock: 'us.anthropic.zy-haiku-4-5-20251022-v1:0',
  vertex: 'zy-haiku-4-5@20251022',
  foundry: 'zy-haiku-4-5',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-haiku-4.5',
  generic: 'zy-haiku-4-5-20251022',
  ollama: 'zy-haiku-4-5-20251022',
  zhipu: 'zy-haiku-4-5-20251022',
  kimi: 'zy-haiku-4-5-20251022',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  anthropic: 'zy-sonnet-4-20250514',
  bedrock: 'us.anthropic.zy-sonnet-4-20250514-v1:0',
  vertex: 'zy-sonnet-4@20250514',
  foundry: 'zy-sonnet-4',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-sonnet-4',
  generic: 'zy-sonnet-4-20250514',
  ollama: 'zy-sonnet-4-20250514',
  zhipu: 'zy-sonnet-4-20250514',
  kimi: 'zy-sonnet-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  anthropic: 'zy-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.zy-sonnet-4-5-20250929-v1:0',
  vertex: 'zy-sonnet-4-5@20250929',
  foundry: 'zy-sonnet-4-5',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-sonnet-4.5',
  generic: 'zy-sonnet-4-5-20250929',
  ollama: 'zy-sonnet-4-5-20250929',
  zhipu: 'zy-sonnet-4-5-20250929',
  kimi: 'zy-sonnet-4-5-20250929',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  anthropic: 'zy-opus-4-20250514',
  bedrock: 'us.anthropic.zy-opus-4-20250514-v1:0',
  vertex: 'zy-opus-4@20250514',
  foundry: 'zy-opus-4',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-opus-4',
  generic: 'zy-opus-4-20250514',
  ollama: 'zy-opus-4-20250514',
  zhipu: 'zy-opus-4-20250514',
  kimi: 'zy-opus-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  anthropic: 'zy-opus-4-1-20250805',
  bedrock: 'us.anthropic.zy-opus-4-1-20250805-v1:0',
  vertex: 'zy-opus-4-1@20250805',
  foundry: 'zy-opus-4-1',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-opus-4.1',
  generic: 'zy-opus-4-1-20250805',
  ollama: 'zy-opus-4-1-20250805',
  zhipu: 'zy-opus-4-1-20250805',
  kimi: 'zy-opus-4-1-20250805',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  anthropic: 'zy-opus-4-5-20251101',
  bedrock: 'us.anthropic.zy-opus-4-5-20251101-v1:0',
  vertex: 'zy-opus-4-5@20251101',
  foundry: 'zy-opus-4-5',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-opus-4.5',
  generic: 'zy-opus-4-5-20251101',
  ollama: 'zy-opus-4-5-20251101',
  zhipu: 'zy-opus-4-5-20251101',
  kimi: 'zy-opus-4-5-20251101',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  anthropic: 'zy-opus-4-6',
  bedrock: 'us.anthropic.zy-opus-4-6-v1',
  vertex: 'zy-opus-4-6',
  foundry: 'zy-opus-4-6',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-opus-4.6',
  generic: 'zy-opus-4-6',
  ollama: 'zy-opus-4-6',
  zhipu: 'zy-opus-4-6',
  kimi: 'zy-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  anthropic: 'zy-sonnet-4-6',
  bedrock: 'us.anthropic.zy-sonnet-4-6',
  vertex: 'zy-sonnet-4-6',
  foundry: 'zy-sonnet-4-6',
  dashscope: 'qwen3.6-plus',
  openrouter: 'anthropic/zy-sonnet-4.6',
  generic: 'zy-sonnet-4-6',
  ollama: 'zy-sonnet-4-6',
  zhipu: 'zy-sonnet-4-6',
  kimi: 'zy-sonnet-4-6',
} as const satisfies ModelConfig

export const QWEN_3_6_PLUS_CONFIG = {
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
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  qwen36plus: QWEN_3_6_PLUS_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical model IDs, e.g. 'zy-opus-4-6' | 'zy-sonnet-4-5-20250929' | … */
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
