import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): 迁移完成并确认不再记录 keybinding_fallback_used 事件后，
// 移除 fallback 参数。fallback 是迁移期的安全兜底：绑定加载失败或找不到 action 时，退回
// 硬编码值。稳定后，调用方应能确信 getBindingDisplayText 总会为已知 action 返回值，届时
// 即可移除此防御逻辑。

// 记录已上报 fallback 事件的 action+context 组合，避免非 React 场景中的重复调用产生重复事件。
const LOGGED_FALLBACKS = new Set<string>()

/**
 * 不借助 React hook 获取已配置快捷键的展示文本。
 * 用于命令、服务等非 React 场景。
 *
 * 此逻辑单独放在本模块而非 useShortcutDisplay.ts，避免 query/stopHooks.ts 等非 React
 * 调用方通过同级 hook 将 React 引入模块依赖图。
 *
 * @param action action 名称，例如 `app:toggleTranscript`
 * @param context 快捷键 context，例如 `Global`
 * @param fallback 找不到绑定时使用的后备文本
 * @returns 已配置快捷键的展示文本
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，未配置时默认返回 'ctrl+o'
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const bindings = loadKeybindingsSync()
  const resolved = getBindingDisplayText(action, context, bindings)
  if (resolved === undefined) {
    const key = `${action}:${context}`
    if (!LOGGED_FALLBACKS.has(key)) {
      LOGGED_FALLBACKS.add(key)
      logEvent('zy_keybinding_fallback_used', {
        action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context: context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback: fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason: 'action_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    return fallback
  }
  return resolved
}
