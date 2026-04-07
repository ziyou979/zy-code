/**
 * UI i18n system — lightweight key-based translation
 *
 * Supported languages: 'en' (default), 'zh-CN'
 * Configured via settings.uiLanguage or ZY_CODE_UI_LANG env var
 */

export type UiLanguage = 'en' | 'zh-CN'

export const SUPPORTED_UI_LANGUAGES: UiLanguage[] = ['en', 'zh-CN']

/**
 * Resolve the effective UI language.
 * Priority: env var > uiLanguage setting > 'en' default
 */
export function resolveUiLanguage(settingsUiLang?: string): UiLanguage {
  const envLang = process.env.ZY_CODE_UI_LANG
  const candidate = envLang ?? settingsUiLang ?? 'en'
  if (SUPPORTED_UI_LANGUAGES.includes(candidate as UiLanguage)) {
    return candidate as UiLanguage
  }
  return 'en'
}
