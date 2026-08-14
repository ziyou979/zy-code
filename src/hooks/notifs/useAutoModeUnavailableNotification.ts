import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { useAppState } from '../../state/AppState.js'
import type { PermissionMode } from '../../services/permissions/permissionMode.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
} from '../../services/permissions/autoModePolicy.js'
import { hasAutoModeOptIn } from '../../services/settings/settings.js'

/**
 * shift-tab 轮播越过原本的 auto 模式位置时显示一次性通知。
 * 涵盖所有原因（settings、circuit-breaker、org-allowlist）。启动时 defaultMode: auto
 * 被静默降级的情况由 verifyAutoModeGateAccess → checkAndDisableAutoModeIfNeeded 处理。
 */
export function useAutoModeUnavailableNotification(): void {
  const { addNotification } = useNotifications()
  const mode = useAppState((s) => s.toolPermissionContext.mode)
  const isAutoModeAvailable = useAppState((s) => s.toolPermissionContext.isAutoModeAvailable)
  const shownRef = useRef(false)
  const prevModeRef = useRef<PermissionMode>(mode)

  useEffect(() => {
    const prevMode = prevModeRef.current
    prevModeRef.current = mode

    if (!true) {
      return
    }
    if (getIsRemoteMode()) {
      return
    }
    if (shownRef.current) {
      return
    }

    const wrappedPastAutoSlot =
      mode === 'default' &&
      prevMode !== 'default' &&
      prevMode !== 'auto' &&
      !isAutoModeAvailable &&
      hasAutoModeOptIn()

    if (!wrappedPastAutoSlot) {
      return
    }

    const reason = getAutoModeUnavailableReason()
    if (!reason) {
      return
    }

    shownRef.current = true
    addNotification({
      key: 'auto-mode-unavailable',
      text: getAutoModeUnavailableNotification(reason),
      color: 'warning',
      priority: 'medium',
    })
  }, [mode, isAutoModeAvailable, addNotification])
}
