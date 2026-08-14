import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { hasImageInClipboard } from '../services/attachments/imagePaste.js'

const NOTIFICATION_KEY = 'clipboard-image-hint'
// 用短暂 debounce 合并连续的焦点变化
const FOCUS_CHECK_DEBOUNCE_MS = 1000
// 在此间隔内最多提示一次
const HINT_COOLDOWN_MS = 30000

/**
 * 终端重新获得焦点且剪贴板中有图片时显示通知。
 *
 * @param isFocused - Whether the terminal is currently focused
 * @param enabled - Whether image paste is enabled (onImagePaste is defined)
 */
export function useClipboardImageHint(isFocused: boolean, enabled: boolean): void {
  const { addNotification } = useNotifications()
  const lastFocusedRef = useRef(isFocused)
  const lastHintTimeRef = useRef(0)
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // 只在焦点恢复时触发（之前失焦，现在聚焦）
    const wasFocused = lastFocusedRef.current
    lastFocusedRef.current = isFocused

    if (!enabled || !isFocused || wasFocused) {
      return
    }

    // 清除尚未执行的检查
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current)
    }

    // 用短暂 debounce 合并连续的焦点变化
    checkTimeoutRef.current = setTimeout(
      async (checkTimeoutRef, lastHintTimeRef, addNotification) => {
        checkTimeoutRef.current = null

        // 检查冷却时间，避免频繁打扰用户
        const now = Date.now()
        if (now - lastHintTimeRef.current < HINT_COOLDOWN_MS) {
          return
        }

        // 检查剪贴板中是否有图片（异步调用 osascript）
        if (await hasImageInClipboard()) {
          lastHintTimeRef.current = now
          addNotification({
            key: NOTIFICATION_KEY,
            text: `Image in clipboard · ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} to paste`,
            priority: 'immediate',
            timeoutMs: 8000,
          })
        }
      },
      FOCUS_CHECK_DEBOUNCE_MS,
      checkTimeoutRef,
      lastHintTimeRef,
      addNotification,
    )

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current)
        checkTimeoutRef.current = null
      }
    }
  }, [isFocused, enabled, addNotification])
}
