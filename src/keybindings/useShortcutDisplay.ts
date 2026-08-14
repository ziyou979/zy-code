import { useEffect, useRef } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

// TODO(keybindings-migration): 迁移完成并确认不再记录 keybinding_fallback_used 事件后，
// 移除 fallback 参数。fallback 是迁移期的安全兜底：绑定加载失败或找不到 action 时，退回
// 硬编码值。稳定后，调用方应能确信 getBindingDisplayText 总会为已知 action 返回值，届时
// 即可移除此防御逻辑。

/**
 * 获取已配置快捷键展示文本的 hook。
 * 返回配置的绑定；无法获取时返回 fallback。
 *
 * @param action action 名称，例如 `app:toggleTranscript`
 * @param context 快捷键 context，例如 `Global`
 * @param fallback 无法获取快捷键 context 时使用的后备文本
 * @returns 已配置快捷键的展示文本
 *
 * @example
 * const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // 返回用户配置的绑定，未配置时默认返回 'ctrl+o'
 */
export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const keybindingContext = useOptionalKeybindingContext()
  const resolved = keybindingContext?.getDisplayText(action, context)
  const isFallback = resolved === undefined
  const reason = keybindingContext ? 'action_not_found' : 'no_context'

  // 每次挂载只记录一次 fallback 使用情况，避免频繁重新渲染时向 analytics 写入大量事件。
  const hasLoggedRef = useRef(false)
  useEffect(() => {
    if (isFallback && !hasLoggedRef.current) {
      hasLoggedRef.current = true
      logEvent('zy_keybinding_fallback_used', {
        action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        context: context as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback: fallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }, [isFallback, action, context, fallback, reason])

  return isFallback ? fallback : resolved
}
