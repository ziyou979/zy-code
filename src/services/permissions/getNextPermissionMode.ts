import type { ToolPermissionContext } from '../../tools/tool.js'
import { createDebugLog } from '../../services/infra/debug.js'

const permLog = createDebugLog('permissions')

import type { PermissionMode } from './permissionMode.js'
import { getAutoModeUnavailableReason, isAutoModeGateEnabled } from './autoModePolicy.js'
import { transitionPermissionMode } from './permissionModeTransitions.js'

// 同时检查启动时由 verifyAutoModeGateAccess 设置的缓存值 isAutoModeAvailable 和实时值
// isAutoModeGateEnabled()；会话中途 circuit breaker 或 settings 变化时二者可能不同。实时
// 检查可防止 transitionPermissionMode 抛出异常（permissionSetup.ts:~559），否则会静默
// 终止 shift+tab handler，使用户卡在当前模式。
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
 * 确定通过 Shift+Tab 循环切换时的下一个权限模式。
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
      // 尚未暴露在 UI 循环中；若意外到达则返回 default
      return 'default'

    default:
      // 未来新增模式一律回退到 default
      return 'default'
  }
}

/**
 * 计算下一个权限模式并准备对应 context，同时完成目标模式所需的 context 清理，例如进入
 * auto mode 时移除危险权限。
 *
 * @returns 下一个模式及其 context；必要时已移除危险权限
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
