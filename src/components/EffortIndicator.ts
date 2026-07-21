import {
  CIRCLE_ALL_BUT_UPPER_LEFT,
  CIRCLE_FILLED,
  CIRCLE_RIGHT_HALF,
  CIRCLE_UPPER_RIGHT,
  RADIO_OFF,
  RADIO_ON,
  SLASHED_CIRCLE,
} from '../constants/figures.js'
import {
  type EffortLevel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../services/effort/effort.js'

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
      return SLASHED_CIRCLE
    case 'on':
      return CIRCLE_RIGHT_HALF
    case 'quick':
      return RADIO_OFF
    case 'light':
      return CIRCLE_UPPER_RIGHT
    case 'balanced':
      return CIRCLE_RIGHT_HALF
    case 'thorough':
      return CIRCLE_ALL_BUT_UPPER_LEFT
    case 'extreme':
    case 'orchestrate':
      return CIRCLE_FILLED
    case 'ultra':
      return RADIO_ON
    default:
      return CIRCLE_ALL_BUT_UPPER_LEFT
  }
}
