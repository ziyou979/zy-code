// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getAPIProvider,
  getProviderAttr,
  providerHasCapability,
} from 'src/services/model/providers.js'
import {
  probedModelSupportsAdaptiveThinking,
  probedModelSupportsThinking,
} from '../services/api/modelCapabilityProbe.js'
import {
  localModelHasCapability,
  localModelHasAdaptiveThinking,
} from './settings/localModelCapabilities.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('zy_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(charIndex: number, shimmer: boolean = false): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// 按 provider 感知的 thinking 支持检测
// 优先级链：本地 model-capabilities.json → API error 运行时降级表 → provider 默认能力
// @[MODEL LAUNCH]: 将新模型添加到 ~/.zy/model-capabilities.json
export function modelSupportsThinking(model: string): boolean {
  if (localModelHasCapability(model, 'thinking')) {
    return true
  }
  const probed = probedModelSupportsThinking(model)
  if (probed !== undefined) {
    return probed
  }
  // provider 声明了 openaiAttr.thinking 也视为支持
  const providerAttr = getProviderAttr()
  if (providerAttr?.thinking) {
    return true
  }
  return false
}

// @[MODEL LAUNCH]: 将新模型添加到 ~/.zy/model-capabilities.json
export function modelSupportsAdaptiveThinking(model: string): boolean {
  if (localModelHasAdaptiveThinking(model)) {
    return true
  }
  const probed = probedModelSupportsAdaptiveThinking(model)
  if (probed !== undefined) {
    return probed
  }
  // 移除 provider 级别 fallback，能力仅从模型配置查询
  return false
}

export function shouldEnableThinkingByDefault(model?: string): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // 模型不支持 thinking 时默认不启用,避免 UI 显示"已启用"但请求侧又被
  // modelSupportsThinking 拦截造成的状态矛盾。model 省略时维持原行为。
  if (model !== undefined && !modelSupportsThinking(model)) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
