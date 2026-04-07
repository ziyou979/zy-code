/**
 * Translation engine — resolves keys against the current locale.
 *
 * Usage:
 *   import { t } from 'src/i18n/index.js'
 *   t('tip.newUserWarmup')                         → string in current language
 *   t('tip.planModeForComplexTasks', { shortcut }) → with interpolation
 */

import { getInitialSettings } from '../utils/settings/settings.js'
import type { UiLanguage } from './types.js'
import { resolveUiLanguage, SUPPORTED_UI_LANGUAGES } from './types.js'

// Lazy-loaded locale maps — never imported at startup
type LocaleLoader = () => Promise<Record<string, string>>
const localeLoaders: Record<string, LocaleLoader> = {
  en: () => import('./locales/en.js').then(m => m.en),
  'zh-CN': () => import('./locales/zh-CN.js').then(m => m.zhCN),
}

let _cachedLang: UiLanguage | undefined
let _cachedMessages: Record<string, string> | undefined

/**
 * Load the message map for the given language (cached after first load).
 */
async function loadMessages(lang: UiLanguage): Promise<Record<string, string>> {
  if (_cachedLang === lang && _cachedMessages) return _cachedMessages
  const loader = localeLoaders[lang]
  if (!loader) {
    const fallback = localeLoaders['en']!
    _cachedMessages = await fallback()
  } else {
    _cachedMessages = await loader()
  }
  _cachedLang = lang
  return _cachedMessages
}

// Synchronous fallback — uses English strings directly.
// The async `t()` should be preferred, but for hot paths (spinner animation)
// we provide a sync path that still respects a pre-warmed cache.
let _syncMessages: Record<string, string> | undefined

function getSyncMessages(): Record<string, string> {
  if (_syncMessages) return _syncMessages
  // Synchronously load English as default — this is safe because the English
  // file is a plain object with no async imports in the compiled output.
  // For production, the startup code should call warmI18n() first.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _syncMessages = require('./locales/en.js').en
  } catch {
    _syncMessages = {}
  }
  return _syncMessages
}

/**
 * Interpolate `{key}` placeholders in a string.
 */
function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k]
    return v !== undefined ? String(v) : `{${k}}`
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-load translations for the current language. Call once at startup.
 */
export async function warmI18n(): Promise<void> {
  const settings = getInitialSettings()
  const lang = resolveUiLanguage(settings.uiLanguage)
  await loadMessages(lang)

  // Also warm the sync cache
  if (lang === 'en') {
    _syncMessages = _cachedMessages
  } else {
    // For non-English, keep English as the sync fallback
    getSyncMessages()
  }
}

/**
 * Get the current UI language (synchronous, reads from settings).
 */
export function getUiLanguage(): UiLanguage {
  const settings = getInitialSettings()
  return resolveUiLanguage(settings.uiLanguage)
}

/**
 * Async translate — loads the locale on first call.
 */
export async function t(
  key: string,
  vars?: Record<string, string | number>,
): Promise<string> {
  const lang = getUiLanguage()
  const messages = await loadMessages(lang)
  const template = messages[key] ?? getSyncMessages()[key] ?? key
  return interpolate(template, vars)
}

/**
 * Sync translate — uses the pre-warmed cache or falls back to English.
 * Safe for hot paths like spinner animation.
 */
export function tSync(
  key: string,
  vars?: Record<string, string | number>,
): string {
  const lang = getUiLanguage()
  const messages =
    _cachedLang === lang ? _cachedMessages : getSyncMessages()
  const template = messages?.[key] ?? getSyncMessages()[key] ?? key
  return interpolate(template, vars)
}

/**
 * Supported UI languages.
 */
export { SUPPORTED_UI_LANGUAGES }
