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

export const MODULE_IDS = ['directory', 'model', 'context', 'tokens', 'cost', 'memory'] as const

export type ModuleId = (typeof MODULE_IDS)[number]

export type ModuleConfig = {
  id: ModuleId
  visible: boolean
  /** undefined = use DEFAULT_MODULES icon; '' = render with no icon prefix. */
  icon?: string
  /** undefined = use DEFAULT_MODULES color; otherwise a theme token name. */
  color?: string
}

/**
 * Default module configuration. Array order = render order (left to right).
 * When the terminal is too narrow, trailing modules are dropped first.
 */
export const DEFAULT_MODULES: readonly ModuleConfig[] = [
  { id: 'directory', visible: true, icon: '▸', color: 'rainbow_blue_shimmer' },
  { id: 'model', visible: true, icon: '', color: 'rainbow_violet_shimmer' },
  { id: 'context', visible: true, icon: '⛁', color: 'success' },
  { id: 'tokens', visible: true, icon: '', color: 'suggestion' },
  { id: 'cost', visible: true, icon: '¥', color: 'warning' },
  { id: 'memory', visible: true, icon: '☰', color: 'inactive' },
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
  cost: ['¥', '$', '€', '£', '¤', '◈', '◆', ''],
  memory: ['☰', '▤', '≡', '▥', '▣', '◫', '☱', '☷', ''],
}

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
