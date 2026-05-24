/**
 * Model deprecation utilities
 */

type DeprecationInfo = {
  isDeprecated: boolean
  modelName?: string
  retirementDate?: string
}

/**
 * Deprecated models and their retirement dates by provider.
 * Keys are substrings to match in model IDs (case-insensitive).
 */
const DEPRECATED_MODELS: Record<string, DeprecationInfo> = {
  // No deprecated models configured
}

/**
 * Check if a model is deprecated and get its deprecation info
 */
function getDeprecatedModelInfo(modelId: string): DeprecationInfo {
  const lowercaseModelId = modelId.toLowerCase()

  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    if (lowercaseModelId.includes(key)) {
      return value
    }
  }

  return { isDeprecated: false }
}

/**
 * Get a deprecation warning message for a model, or null if not deprecated
 */
export function getModelDeprecationWarning(modelId: string | null): string | null {
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId)
  if (!info.isDeprecated) {
    return null
  }

  return `⚠ ${info.modelName} will be retired on ${info.retirementDate}. Consider switching to a newer model.`
}
