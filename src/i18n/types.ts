/**
 * UI i18n 系统——基于 key 的轻量翻译机制。
 *
 * 支持语言：'en'（默认）、'zh-CN'。
 * 根据 settings.language（自由格式的回复语言）推导。
 */

export type UiLanguage = 'en' | 'zh-CN'

export const SUPPORTED_UI_LANGUAGES: UiLanguage[] = ['en', 'zh-CN']

/**
 * 将自由格式的语言设置映射为受支持的 UI 语言。
 * 优先级：环境变量 > 语言设置 > 默认的 'en'
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
