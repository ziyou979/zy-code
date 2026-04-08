/**
 * UI i18n system — lightweight key-based translation
 *
 * Supported languages: 'en' (default), 'zh-CN'
 * Derived from settings.language (free-form response language)
 */

export type UiLanguage = 'en' | 'zh-CN'

export const SUPPORTED_UI_LANGUAGES: UiLanguage[] = ['en', 'zh-CN']

/**
 * Map a free-form language setting to a supported UI language.
 * Priority: env var > language setting > 'en' default
 */
export function resolveUiLanguage(settingsLanguage?: string): UiLanguage {
  const envLang = process.env.ZY_CODE_UI_LANG
  const raw = (envLang ?? settingsLanguage ?? 'en').trim().toLowerCase()

  // Check exact supported UI languages first
  if (SUPPORTED_UI_LANGUAGES.includes(raw as UiLanguage)) {
    return raw as UiLanguage
  }

  // Map common language names to UI language codes
  if (
    raw === 'chinese' ||
    raw === '中文' ||
    raw === 'zh' ||
    raw === 'zh-cn' ||
    raw === 'zh_cn' ||
    raw.startsWith('zh-')
  ) {
    return 'zh-CN'
  }

  return 'en'
}
