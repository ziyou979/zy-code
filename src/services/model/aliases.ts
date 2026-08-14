export const MODEL_ALIASES = ['advanced', 'standard', 'compact'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * 在 availableModels allowlist 中作为通配符使用的裸模型系列别名。
 * allowlist 包含 "advanced" 时，该 tier 配置的任意模型都可使用。
 */
export const MODEL_FAMILY_ALIASES = ['advanced', 'standard', 'compact'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
