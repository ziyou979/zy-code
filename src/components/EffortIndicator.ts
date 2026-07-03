import {
  EFFORT_BALANCED,
  EFFORT_EXTREME,
  EFFORT_LIGHT,
  EFFORT_OFF,
  EFFORT_ON,
  EFFORT_QUICK,
  EFFORT_THOROUGH,
  EFFORT_ULTRA,
} from '../constants/figures.js'
import { type EffortLevel, getDisplayedEffortLevel, modelSupportsEffort } from '../utils/effort.js'

/**
 * Build the text for the effort-changed notification, e.g. "◐ medium · /effort".
 * Returns undefined if the model doesn't support effort.
 */
export function getEffortNotificationText(
  effortValue: EffortLevel | undefined,
  model: string,
): string | undefined {
  if (!modelSupportsEffort(model)) {
    return undefined
  }
  const level = getDisplayedEffortLevel(model, effortValue)
  return `${effortLevelToSymbol(level)} ${level} · /effort`
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'off':
      return EFFORT_OFF
    case 'on':
      return EFFORT_ON
    case 'quick':
      return EFFORT_QUICK
    case 'light':
      return EFFORT_LIGHT
    case 'balanced':
      return EFFORT_BALANCED
    case 'thorough':
      return EFFORT_THOROUGH
    case 'extreme':
    case 'orchestrate':
      return EFFORT_EXTREME
    case 'ultra':
      return EFFORT_ULTRA
    default:
      return EFFORT_THOROUGH
  }
}
