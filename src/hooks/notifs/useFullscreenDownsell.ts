import { useEffect } from 'react'
import type { Notification } from '../../context/notifications.js'
import { tSync } from '../../i18n/index.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { isFullscreenEnvEnabled } from '../../services/terminal/fullscreen.js'

/**
 * 全屏模式 downsell 提示：向已进入全屏的用户展示操作技巧。
 * 展示 5 次后，若用户未显式设置 tui 偏好，自动写入
 * tui: 'fullscreen'（静默毕业），不再展示。
 */
export function useFullscreenDownsell(addNotification: (n: Notification) => void): void {
  useEffect(() => {
    if (!isFullscreenEnvEnabled()) {
      return
    }
    const config = getGlobalConfig()
    // 已有明确的 tui 偏好则不展示
    if (config.tui !== undefined) {
      return
    }
    const count = config.fullscreenDownsellSeenCount ?? 0

    // 5 次后静默毕业
    if (count >= 5) {
      saveGlobalConfig((prev) => {
        if (prev.tui !== undefined) {
          return prev
        }
        return { ...prev, tui: 'fullscreen' as const }
      })
      logEvent('zy_fullscreen_downsell_persisted', { seen_count: count })
      return
    }

    const newCount = count + 1
    saveGlobalConfig((prev) => {
      if ((prev.fullscreenDownsellSeenCount ?? 0) >= newCount) {
        return prev
      }
      return { ...prev, fullscreenDownsellSeenCount: newCount }
    })

    const hints = [
      tSync('fullscreen.downsell.scrollHint'),
      tSync('fullscreen.downsell.selectHint'),
      tSync('fullscreen.downsell.switchBack'),
    ]
    const hint = hints[count % hints.length]!

    addNotification({
      key: 'fullscreen-downsell',
      text: hint,
      priority: 'low',
      timeoutMs: 12000,
    })

    logEvent('zy_fullscreen_downsell_shown', { seen_count: newCount })
  }, [addNotification])
}
