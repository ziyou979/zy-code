import type { ToolPermissionContext } from '../../tools/tool.js'
import { createDebugLog } from '../../utils/debug.js'

const permLog = createDebugLog('permissions')

import type { PermissionMode } from './permissionMode.js'
import {
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  transitionPermissionMode,
} from './permissionSetup.js'

// Checks both the cached isAutoModeAvailable (set at startup by
// verifyAutoModeGateAccess) and the live isAutoModeGateEnabled() — these can
// diverge if the circuit breaker or settings change mid-session. The
// live check prevents transitionPermissionMode from throwing
// (permissionSetup.ts:~559), which would silently crash the shift+tab handler
// and leave the user stuck at the current mode.
function canCycleToAuto(ctx: ToolPermissionContext): boolean {
  const gateEnabled = isAutoModeGateEnabled()
  const can = !!ctx.isAutoModeAvailable && gateEnabled
  if (!can) {
    permLog(
      `[auto-mode] canCycleToAuto=false: ctx.isAutoModeAvailable=${ctx.isAutoModeAvailable} isAutoModeGateEnabled=${gateEnabled} reason=${getAutoModeUnavailableReason()}`,
    )
  }
  return can
}

/**
 * Determines the next permission mode when cycling through modes with Shift+Tab.
 */
export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _teamContext?: { leadAgentId: string },
): PermissionMode {
  switch (toolPermissionContext.mode) {
    // 手动模式 → 计划模式（权限最低到最高）
    case 'default':
      return 'plan'

    // 计划模式 → 接受编辑
    case 'plan':
      return 'acceptEdits'

    // 接受编辑 → 自动模式（可用时）/ 跳过权限（可用时）/ 手动模式
    case 'acceptEdits':
      if (canCycleToAuto(toolPermissionContext)) {
        return 'auto'
      }
      if (toolPermissionContext.isBypassPermissionsModeAvailable) {
        return 'bypassPermissions'
      }
      return 'default'

    // 自动模式 → 跳过权限（可用时）/ 手动模式
    case 'auto':
      if (toolPermissionContext.isBypassPermissionsModeAvailable) {
        return 'bypassPermissions'
      }
      return 'default'

    // 跳过权限 → 手动模式
    case 'bypassPermissions':
      return 'default'

    case 'dontAsk':
      // Not exposed in UI cycle yet, but return default if somehow reached
      return 'default'

    default:
      // Any future modes — always fall back to default
      return 'default'
  }
}

/**
 * Computes the next permission mode and prepares the context for it.
 * Handles any context cleanup needed for the target mode (e.g., stripping
 * dangerous permissions when entering auto mode).
 *
 * @returns The next mode and the context to use (with dangerous permissions stripped if needed)
 */
export function cyclePermissionMode(
  toolPermissionContext: ToolPermissionContext,
  teamContext?: { leadAgentId: string },
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(toolPermissionContext, teamContext)
  return {
    nextMode,
    context: transitionPermissionMode(toolPermissionContext.mode, nextMode, toolPermissionContext),
  }
}
