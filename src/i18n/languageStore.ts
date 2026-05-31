/**
 * 语言状态叶子 —— i18n 的当前语言单一事实来源（对标 i18next 的 current lng）。
 *
 * 仅依赖 ./types（纯函数，只读 process.env），**不 import settings 或任何业务模块**。
 * 因此 settings 与 i18n 都能安全地依赖它而不构成循环 —— 这是断开
 * 「settings ↔ i18n」循环初始化（历史上的 TDZ 崩溃）的关键叶子。
 *
 * 写入（setLanguage，对标 i18next.changeLanguage）只在两类权威时刻发生：
 *   1) settings 加载/重载完成 —— settings.getSettingsWithErrors 推送生效语言；
 *   2) 应用内切换语言 —— LanguagePicker 的 onComplete。
 * 读取（getLanguage）是 O(1) 取变量，**绝不触碰 settings** —— tSync 热路径零依赖、永不 TDZ。
 */
import type { UiLanguage } from './types.js'
import { resolveUiLanguage } from './types.js'

// 推送之前的默认值：env（ZY_CODE_UI_LANG）或 'en'，与 i18next init 前的默认 lng 同义。
let current: UiLanguage = resolveUiLanguage(undefined)

type Listener = (lang: UiLanguage) => void
const listeners = new Set<Listener>()

/** 当前 UI 语言（同步、O(1)、无副作用、无 settings 依赖）。 */
export function getLanguage(): UiLanguage {
  return current
}

/**
 * 推送语言来源（settings 的原始 language 字段，或 undefined 表示未配置）。
 * env 始终优先（见 resolveUiLanguage）。值未变化则 no-op；变化时通知订阅者
 * （如 i18n 重新预热消息缓存）。
 */
export function setLanguage(settingsLanguage?: string): void {
  const next = resolveUiLanguage(settingsLanguage)
  if (next === current) {
    return
  }
  current = next
  for (const listener of listeners) {
    listener(next)
  }
}

/** 订阅语言变化，返回取消订阅函数。 */
export function onLanguageChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
