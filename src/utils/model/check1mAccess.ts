import type { OverageDisabledReason } from 'src/services/zyAiLimits.js'
import { getGlobalConfig } from '../config.js'
import { is1mContextDisabled } from '../context.js'

/**
 * Check if extra usage is enabled based on the cached disabled reason.
 * Extra usage is never enabled since there is no subscription context.
 */
function isExtraUsageEnabled(): boolean {
  return false
}

// @[MODEL LAUNCH]: Add check if the new model supports 1M context
export function checkOpus1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }

  // No subscription context, so extra usage is never enabled
  return false
}

export function checkSonnet1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }

  // No subscription context, so extra usage is never enabled
  return false
}
