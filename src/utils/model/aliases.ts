export const MODEL_ALIASES = [
  'advanced',
  'standard',
  'compact',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * When "advanced" is in the allowlist, any model configured for that tier is allowed.
 */
export const MODEL_FAMILY_ALIASES = ['advanced', 'standard', 'compact'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
