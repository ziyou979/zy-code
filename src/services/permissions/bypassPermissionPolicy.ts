/**
 * Bypass permissions 策略：门控检查、禁用、上下文清理。
 *
 * 从 permissionSetup.ts 提取。负责 bypassPermissions 模式的生命周期：
 * Statsig 门控读取、设置检查、上下文转换。
 */
import type { ToolPermissionContext } from '../../tools/tool.js'
import { gracefulShutdown } from '../../bootstrap/lifecycle/gracefulShutdown.js'
import {
  checkSecurityRestrictionGate,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getInitialSettings } from '../settings/settings.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { applyPermissionUpdate } from './permissionUpdate.js'

const permLog = createDebugLog('bypass-permissions')

/**
 * 核心逻辑：根据 Statsig 门控检查是否应禁用 bypassPermissions
 */
export function shouldDisableBypassPermissions(): Promise<boolean> {
  return checkSecurityRestrictionGate('zy_disable_bypass_permissions_mode')
}

/**
 * 检查 bypassPermissions 模式当前是否被 Statsig 门控或设置禁用。
 * 这是使用缓存 Statsig 值的同步版本。
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const growthBookDisableBypassPermissionsMode = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'zy_disable_bypass_permissions_mode',
  )
  const settings = getInitialSettings() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  return growthBookDisableBypassPermissionsMode || settingsDisableBypassPermissionsMode
}

/**
 * 创建禁用 bypassPermissions 模式的更新上下文
 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let updatedContext = currentContext
  if (currentContext.mode === 'bypassPermissions') {
    updatedContext = applyPermissionUpdate(currentContext, {
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    })
  }

  return {
    ...updatedContext,
    isBypassPermissionsModeAvailable: false,
  }
}

/**
 * 根据 Statsig 门控异步检查是否应禁用 bypassPermissions 模式，
 * 并在需要时返回更新后的 toolPermissionContext
 */
export async function checkAndDisableBypassPermissions(
  currentContext: ToolPermissionContext,
): Promise<void> {
  // 仅在 bypassPermissions 模式可用时继续
  if (!currentContext.isBypassPermissionsModeAvailable) {
    return
  }

  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) {
    return
  }

  // 门控已启用，需要禁用 bypassPermissions 模式
  permLog('bypassPermissions mode is being disabled by Statsig gate (async check)', {
    level: 'warn',
  })

  void gracefulShutdown(1, 'bypass_permissions_disabled')
}
