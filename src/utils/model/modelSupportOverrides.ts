import memoize from 'lodash-es/memoize.js'
import { getAPIProvider, isCompatibleProvider } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ZY_CODE_DEFAULT_BEST_MODEL',
    capabilitiesEnvVar: 'ZY_CODE_DEFAULT_BEST_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ZY_CODE_DEFAULT_ADVANCED_MODEL',
    capabilitiesEnvVar: 'ZY_CODE_DEFAULT_ADVANCED_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ZY_CODE_DEFAULT_COMPACT_MODEL',
    capabilitiesEnvVar: 'ZY_CODE_DEFAULT_COMPACT_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ZY_CODE_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    const provider = getAPIProvider()
    if (isCompatibleProvider(provider)) {
      return undefined
    }
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)
