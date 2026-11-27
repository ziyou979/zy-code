/**
 * 翻译引擎 — 根据当前语言环境解析键。
 *
 * 用法：
 *   import { t } from 'src/i18n/index.js'
 *   t('tip.newUserWarmup')                         → 当前语言的字符串
 *   t('tip.planModeForComplexTasks', { shortcut }) → 带插值
 */

import { getLanguage, onLanguageChange } from './languageStore.js'
import type { UiLanguage } from './types.js'
import { SUPPORTED_UI_LANGUAGES } from './types.js'

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
      if (lang === 'zh-CN') {
        // 写成字面量路径：打包器才会把它收进产物（模板字符串路径的 require 在 dist 里解析失败，
        // 未预热时 tSync 会退化成输出 key 本身）
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _syncMessages = require('./locales/zh-CN.js').zhCN
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _syncMessages = require('./locales/en.js').en
      }
    }
  } catch {
    _syncMessages = {}
  }
  _syncMessagesLang = lang
  return _syncMessages ?? {}
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
  const lang = getUiLanguage()
  const messages = await loadMessages(lang)

  // 内容和语言标签必须一起更新；交错预热不能让新内容沿用旧语言标签。
  _syncMessages = messages
  _syncMessagesLang = lang
}

/**
 * 获取当前 UI 语言（同步）。读取 languageStore 这个零依赖叶子 —— O(1) 取变量，
 * 绝不触碰 settings，因此模块顶层调用也绝不会 TDZ（断环）。语言由 settings 层
 * 与 LanguagePicker 经 setLanguage 推入 store（对标 i18next.changeLanguage）。
 */
export function getUiLanguage(): UiLanguage {
  return getLanguage()
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

let _enMessages: Record<string, string> | undefined

/** 英文资源（同步、缓存）。只给 tEn 与「按英文模板反查」的逻辑用。 */
export function getEnMessages(): Record<string, string> {
  if (!_enMessages) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _enMessages = require('./locales/en.js').en as Record<string, string>
  }
  return _enMessages
}

/**
 * 固定取英文模板，与当前界面语言无关。
 *
 * 用于「持久化 / 被字符串匹配 / 可能回传给模型」的文本：内容必须稳定为英文字节，
 * 但文案仍以 locale 为唯一事实来源，渲染层再按 key 反查翻译
 * （见 services/api/errorText.ts 的 localizeApiErrorText）。
 */
export function tEn(key: string, vars?: Record<string, string | number>): string {
  return interpolate(getEnMessages()[key] ?? key, vars)
}

// 语言变化时重新预热消息缓存（mirrors i18next：changeLanguage 触发资源加载），
// 使运行时切换语言后同步路径（tSync）也即时拿到新语言文案，无需各调用点手动 warm。
onLanguageChange(() => {
  void warmI18n()
})

/**
 * 支持的 UI 语言。
 */
export { SUPPORTED_UI_LANGUAGES }
