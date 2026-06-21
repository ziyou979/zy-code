import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isInternalBuild } from './envUtils.js'

/**
 * Whether inference-config commands (/model, /effort) should execute
 * immediately (during a running query) rather than waiting for the current
 * turn to finish.
 *
 * Always enabled for ants; gated by experiment for external users.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    isInternalBuild() || getFeatureValue_CACHED_MAY_BE_STALE('zy_immediate_model_command', false)
  )
}
