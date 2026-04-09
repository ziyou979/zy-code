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

// Synchronous fallback — tries to load the current language messages
// synchronously if the async cache hasn't been warmed yet.
let _syncMessages: Record<string, string> | undefined
let _syncMessagesLang: string | undefined

function getSyncMessages(): Record<string, string> {
  const lang = getUiLanguage()
  if (_syncMessages && _syncMessagesLang === lang) return _syncMessages
  // Try to load the current language synchronously
  try {
    if (lang === 'en') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _syncMessages = require('./locales/en.js').en
    } else {
      const loader = localeLoaders[lang]
      if (loader) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const localeModule = require(`./locales/${lang}.js`)
        _syncMessages = lang === 'zh-CN' ? localeModule.zhCN : localeModule[lang]
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _syncMessages = require('./locales/en.js').en
      }
    }
  } catch {
    _syncMessages = {}
  }
  _syncMessagesLang = lang
  return _syncMessages
}

/**
 * 将 `{key}` 占位符替换为 vars 中的值
 */
function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template
  return template.replace(/\{(\w+)}/g, (_, k: string) => {
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
  const lang = resolveUiLanguage(settings.language)
  await loadMessages(lang)

  // Always update the sync cache so tSync can find translations before warmI18n completes
  if (lang === 'en') {
    _syncMessages = _cachedMessages
  } else {
    // For non-English, load the current language messages into sync cache
    _syncMessages = _cachedMessages
  }
}

/**
 * Get the current UI language (synchronous, reads from settings).
 */
export function getUiLanguage(): UiLanguage {
  const settings = getInitialSettings()
  return resolveUiLanguage(settings.language)
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
 * Sync translate — uses the pre-warmed cache or loads the current locale synchronously.
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
