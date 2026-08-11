import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

export const CustomModelSchema = lazySchema(() =>
  z.object({
    alias: z
      .string()
      .describe(
        'Short alias for the model (e.g., "qwen-max", "glm-4"). Used as the settings value.',
      ),
    model: z
      .string()
      .describe('Actual model ID sent to the API (e.g., "qwen-max-latest", "glm-4-plus").'),
    provider: z
      .string()
      .optional()
      .describe(
        'Provider id used when this custom model is selected. Defaults to active provider.',
      ),
    label: z
      .string()
      .optional()
      .describe('Display name in the model picker. Defaults to alias if not provided.'),
    description: z
      .string()
      .optional()
      .describe('Description shown below the model name in the picker.'),
  }),
)

/** 单条模型引用对象（含可选 provider） */
export const ModelReferenceObjectSchema = lazySchema(() =>
  z
    .object({
      provider: z
        .string()
        .optional()
        .describe(
          'auth.json connection id or registered provider id used for this model entry. Defaults to active provider.',
        ),
      model: z.string().describe('Actual model ID sent to the API.'),
      label: z.string().optional().describe('Optional display label for this candidate.'),
    })
    .passthrough(),
)

export const ModelReferenceSchema = lazySchema(() =>
  z.union([z.string(), ModelReferenceObjectSchema()]),
)

/**
 * 档位值：单通道（兼容）或有序候选列表（多 auth 混用）。
 * 数组下标越小优先级越高；失效后按序切换。
 */
export const ModelTierValueSchema = lazySchema(() =>
  z.union([
    ModelReferenceSchema(),
    z
      .array(ModelReferenceObjectSchema())
      .min(1)
      .describe(
        'Ordered failover candidates for this tier. First entry is preferred; later entries are used after repeated auth/quota failures.',
      ),
  ]),
)

/** 多 auth 失效切换策略 */
export const ModelFailoverSchema = lazySchema(() =>
  z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe(
          'Enable automatic auth/model failover when a tier has multiple candidates. Defaults to true when a candidate list is configured.',
        ),
      maxConsecutiveFailures: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe(
          'Consecutive switchable failures (auth / rate-limit exhausted) before advancing to the next candidate. Default: 2.',
        ),
    })
    .passthrough(),
)

export const ProviderScopedSettingsSchema = lazySchema(() =>
  z
    .object({
      baseUrl: z
        .string()
        .optional()
        .describe(
          'Deprecated compatibility field. Put baseUrl in the referenced auth.json connection.',
        ),
      apiFormat: z
        .enum(['anthropic', 'openai-chat', 'openai-responses', 'google'])
        .optional()
        .describe('API protocol format for this provider. Overrides the top-level apiFormat.'),
      model: ModelReferenceSchema()
        .optional()
        .describe(
          'Default model override for this provider. May be a model id or { provider, model }.',
        ),
      mainLoopModel: z
        .enum(['advanced', 'standard', 'compact'])
        .optional()
        .describe('Capability tier for this provider. Overrides the top-level mainLoopModel.'),
      models: z
        .record(z.string(), ModelTierValueSchema())
        .optional()
        .describe(
          'Model configuration by capability tier for this provider. Values may be a model id, { provider, model }, or an ordered candidate array for multi-auth failover.',
        ),
      customModels: z
        .array(CustomModelSchema())
        .optional()
        .describe('Custom model definitions for this provider.'),
    })
    .passthrough(),
)
