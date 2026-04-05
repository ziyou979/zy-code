export const MODEL_ALIASES = [
  'best',
  'advanced',
  'standard',
  'compact',
  'opus',
  'sonnet',
  'haiku',
  'opusplan',
  'best[1m]',
  'advanced[1m]',
  'standard[1m]',
  'compact[1m]',
  'opus[1m]',
  'sonnet[1m]',
  'haiku[1m]',
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
