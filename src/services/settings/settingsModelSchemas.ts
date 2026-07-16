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

export const ModelReferenceSchema = lazySchema(() =>
  z.union([
    z.string(),
    z
      .object({
        provider: z
          .string()
          .optional()
          .describe('Provider id used for this model entry. Defaults to active provider.'),
        model: z.string().describe('Actual model ID sent to the API.'),
      })
      .passthrough(),
  ]),
)

export const ProviderScopedSettingsSchema = lazySchema(() =>
  z
    .object({
      baseUrl: z
        .string()
        .optional()
        .describe(
          'Base URL for this provider. Overrides the top-level baseUrl for this provider only.',
        ),
      apiFormat: z
        .enum(['anthropic', 'openai', 'google'])
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
        .record(z.string(), ModelReferenceSchema())
        .optional()
        .describe(
          'Model configuration by capability tier for this provider. Values may be a model id or { provider, model }.',
        ),
      customModels: z
        .array(CustomModelSchema())
        .optional()
        .describe('Custom model definitions for this provider.'),
    })
    .passthrough(),
)
