import {
  CIRCLE_ALL_BUT_UPPER_LEFT,
  CIRCLE_FILLED,
  CIRCLE_RIGHT_HALF,
  CIRCLE_UPPER_RIGHT,
  RADIO_OFF,
  RADIO_ON,
  SLASHED_CIRCLE,
} from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import {
  type EffortLevel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../services/effort/effort.js'

/**
 * Build the text for the effort-changed notification, e.g. "◐ 深度 · /effort".
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
  // 档位名走 i18n（effort.<level>），避免通知栏直接输出英文枚举标识符；
  // 模板复用 effort.levelWithShortcut（孤儿 key，本就为此通知准备）
  return tSync('effort.levelWithShortcut', {
    level: `${effortLevelToSymbol(level)} ${tSync(`effort.${level}`)}`,
  })
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
