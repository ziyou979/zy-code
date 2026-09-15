/**
 * Statusline module defaults — single source of truth for the built-in status
 * bar (BuiltInStatusBar) and the /statusline configuration dialog.
 *
 * - DEFAULT_MODULES defines the canonical render order, default icons, and
 *   default color tokens.
 * - ICON_LIBRARY is the curated picker library per module (all 1-cell unicode
 *   to keep terminal width math stable). The empty string '' means "no icon".
 * - COLOR_TOKENS is the picker library for theme color tokens.
 */

import { TAU } from '../../constants/figures.js'
import {
  STATUSLINE_MODULE_IDS,
  type StatuslineModuleConfig,
  type StatuslineModuleId,
  type StatuslinePathMode,
} from '../../services/settings/statuslineTypes.js'

export const MODULE_IDS = STATUSLINE_MODULE_IDS
export type ModuleId = StatuslineModuleId
export type ModuleConfig = StatuslineModuleConfig

/**
 * Default module configuration. Array order = render order (left to right).
 * When the terminal is too narrow, trailing modules are dropped first.
 */
export const DEFAULT_MODULES: readonly ModuleConfig[] = [
  {
    id: 'directory',
    visible: true,
    icon: '▸',
    color: 'rainbow_blue_shimmer',
    pathMode: 'name',
  },
  { id: 'model', visible: true, icon: '', color: 'rainbow_violet_shimmer' },
  { id: 'context', visible: true, icon: '⛁', color: 'success' },
  { id: 'tokens', visible: true, icon: '', color: 'suggestion' },
  { id: 'cache', visible: true, icon: '⊛', color: 'rainbow_green_shimmer' },
  { id: 'speed', visible: true, icon: '', color: 'rainbow_orange_shimmer' },
  { id: 'turns', visible: true, icon: '', color: 'rainbow_indigo_shimmer' },
  { id: 'cost', visible: true, icon: '¥', color: 'warning' },
  { id: 'memory', visible: true, icon: '≡', color: 'inactive' },
]

/**
 * Curated icon library per module. All entries should be 1 cell wide.
 * First non-empty entry per group is the recommended default; '' is the
 * explicit "no icon" choice.
 */
export const ICON_LIBRARY: Record<ModuleId, readonly string[]> = {
  directory: ['▸', '▹', '▾', '❯', '›', '◇', '◈', '◆', ''],
  model: ['◆', '◇', '◈', '★', '✦', '◉', '⊙', '⊚', ''],
  context: ['⛁', '▦', '▤', '▥', '◰', '◱', '◲', '◳', '▒', '▓', ''],
  tokens: ['↕', '⇅', '⇡', '⇣', '◆', '◇', ''],
  cache: ['⊛', '◎', '◉', '◍', '↺', '⇄', ''],
  speed: ['»', '↯', 'τ', '▶', '›', ''],
  turns: ['#', '⟳', '⇄', 'T', ''],
  cost: ['¥', '$', '€', '£', '₩', '₹', '₽', '₿', ''],
  memory: ['☰', '▤', '≡', '▥', '▣', '◫', '☱', '☷', ''],
}

/**
 * Curated TTFT symbol library for the speed module（嵌入段内、非模块前缀 icon）。
 * 全部 1 格宽：避开 ⏱/emoji 类（JetBrains 内置终端缺字形或宽度错乱，
 * 理由同 constants/figures.ts 的 TAU 注释），希腊字母/箭头区覆盖稳定。
 * 默认不显示符号（''）——「首token」文案已自解释，符号仅是可选装饰。
 */
export const TTFT_SYMBOL_LIBRARY: readonly string[] = [TAU, 't', '†', '→', '⇣', '']

/**
 * Curated theme color tokens for the color picker. Each entry references a
 * key on the Theme type (see src/utils/theme.ts). Labels are i18n keys; UI
 * resolves them via tSync.
 */
export const COLOR_TOKENS: readonly { token: string; labelKey: string }[] = [
  { token: 'text', labelKey: 'statusline.color.text' },
  { token: 'suggestion', labelKey: 'statusline.color.suggestion' },
  { token: 'success', labelKey: 'statusline.color.success' },
  { token: 'warning', labelKey: 'statusline.color.warning' },
  { token: 'error', labelKey: 'statusline.color.error' },
  { token: 'inactive', labelKey: 'statusline.color.inactive' },
  { token: 'permission', labelKey: 'statusline.color.permission' },
  { token: 'remember', labelKey: 'statusline.color.remember' },
  { token: 'rainbow_blue_shimmer', labelKey: 'statusline.color.blue' },
  { token: 'rainbow_violet_shimmer', labelKey: 'statusline.color.violet' },
  { token: 'rainbow_green_shimmer', labelKey: 'statusline.color.green' },
  { token: 'rainbow_orange_shimmer', labelKey: 'statusline.color.orange' },
  { token: 'rainbow_red_shimmer', labelKey: 'statusline.color.red' },
  { token: 'rainbow_yellow_shimmer', labelKey: 'statusline.color.yellow' },
  { token: 'rainbow_indigo_shimmer', labelKey: 'statusline.color.indigo' },
]

/** Resolves user-overridden icon, falling back to the default for the module. */
export function effectiveIcon(module: ModuleConfig): string {
  if (module.icon !== undefined) {
    return module.icon
  }
  const def = DEFAULT_MODULES.find((m) => m.id === module.id)
  return def?.icon ?? ''
}

/** Resolves user-overridden color token, falling back to the default. */
export function effectiveColor(module: ModuleConfig): string {
  if (module.color !== undefined) {
    return module.color
  }
  const def = DEFAULT_MODULES.find((m) => m.id === module.id)
  return def?.color ?? 'text'
}

/** Resolves directory module path display mode, defaulting to project name. */
export function effectivePathMode(module: ModuleConfig): StatuslinePathMode {
  if (module.pathMode !== undefined) {
    return module.pathMode
  }
  const def = DEFAULT_MODULES.find((m) => m.id === module.id)
  return def?.pathMode ?? 'name'
}

/**
 * Resolves speed module TTFT symbol。默认 ''（不显示符号）：
 * 「首token」文案已自解释，符号由用户在 /statusline 里自选装饰。
 */
export function effectiveTtftSymbol(module: ModuleConfig): string {
  return module.ttftSymbol ?? ''
}

/**
 * Merge user-configured modules with the default list to ensure new modules
 * added in code automatically appear (with their defaults) for existing
 * users — and to drop unknown ids from older configs.
 */
export function mergeWithDefaults(configured: readonly ModuleConfig[] | undefined): ModuleConfig[] {
  if (!configured || configured.length === 0) {
    return DEFAULT_MODULES.map((m) => ({ ...m }))
  }
  const knownIds = new Set<ModuleId>(MODULE_IDS)
  // Keep user order; drop unknown ids
  const filtered = configured.filter((m) => knownIds.has(m.id))
  const seen = new Set(filtered.map((m) => m.id))
  // Append any new built-in modules the user hasn't seen yet
  for (const def of DEFAULT_MODULES) {
    if (!seen.has(def.id)) {
      filtered.push({ ...def })
    }
  }
  return filtered
}
