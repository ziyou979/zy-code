/**
 * 翻译引擎 — 根据当前语言环境解析键。
 *
 * 用法：
 *   import { t } from 'src/i18n/index.js'
 *   t('tip.newUserWarmup')                         → 当前语言的字符串
 *   t('tip.planModeForComplexTasks', { shortcut }) → 带插值
 */

import { getInitialSettings } from '../utils/settings/settings.js'
import type { UiLanguage } from './types.js'
import { resolveUiLanguage, SUPPORTED_UI_LANGUAGES } from './types.js'

// 懒加载的语言环境映射 — 启动时从不导入
type LocaleLoader = () => Promise<Record<string, string>>
const localeLoaders: Record<string, LocaleLoader> = {
  en: () => import('./locales/en.js').then((m) => m.en),
  'zh-CN': () => import('./locales/zh-CN.js').then((m) => m.zhCN),
}

let _cachedLang: UiLanguage | undefined
let _cachedMessages: Record<string, string> | undefined

/**
 * 加载给定语言的消息映射（首次加载后缓存）。
 */
async function loadMessages(lang: UiLanguage): Promise<Record<string, string>> {
  if (_cachedLang === lang && _cachedMessages) {
    return _cachedMessages
  }
  const loader = localeLoaders[lang]
  if (!loader) {
    const fallback = localeLoaders.en!
    _cachedMessages = await fallback()
  } else {
    _cachedMessages = await loader()
  }
  _cachedLang = lang
  return _cachedMessages
}

// 同步回退 — 如果异步缓存尚未预热，则尝试同步加载当前语言消息。
let _syncMessages: Record<string, string> | undefined
let _syncMessagesLang: string | undefined

function getSyncMessages(): Record<string, string> {
  const lang = getUiLanguage()
  if (_syncMessages && _syncMessagesLang === lang) {
    return _syncMessages
  }
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
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return template
  }
  return template.replace(/\{(\w+)}/g, (_, k: string) => {
    const v = vars[k]
    return v !== undefined ? String(v) : `{${k}}`
  })
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 预加载当前语言的翻译。启动时调用一次。
 */
export async function warmI18n(): Promise<void> {
  const settings = getInitialSettings()
  const lang = resolveUiLanguage(settings.language)
  await loadMessages(lang)

  // 始终更新同步缓存，以便 tSync 在 warmI18n 完成之前能找到翻译
  if (lang === 'en') {
    _syncMessages = _cachedMessages
  } else {
    // 对于非英语，将当前语言消息加载到同步缓存
    _syncMessages = _cachedMessages
  }
}

/**
 * 获取当前 UI 语言（同步，从设置中读取）。
 */
export function getUiLanguage(): UiLanguage {
  const settings = getInitialSettings()
  return resolveUiLanguage(settings.language)
}

/**
 * 异步翻译 — 首次调用时加载语言环境。
 */
export async function t(key: string, vars?: Record<string, string | number>): Promise<string> {
  const lang = getUiLanguage()
  const messages = await loadMessages(lang)
  const template = messages[key] ?? getSyncMessages()[key] ?? key
  return interpolate(template, vars)
}

/**
 * 同步翻译 — 使用预热的缓存或同步加载当前语言环境。适用于如旋转动画等热路径。
 */
export function tSync(key: string, vars?: Record<string, string | number>): string {
  const lang = getUiLanguage()
  const messages = _cachedLang === lang ? _cachedMessages : getSyncMessages()
  const template = messages?.[key] ?? getSyncMessages()[key] ?? key
  return interpolate(template, vars)
}

/**
 * 支持的 UI 语言。
 */
export { SUPPORTED_UI_LANGUAGES }
