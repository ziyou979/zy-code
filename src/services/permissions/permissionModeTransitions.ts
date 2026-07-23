/**
 * 权限模式转换：模式间切换、plan 模式入口/出口、plan 期间 auto 协调。
 *
 * 从 permissionSetup.ts 提取。处理 TransitionPermissionMode、
 * prepareContextForPlanMode、transitionPlanAutoMode 等模式生命周期逻辑。
 */
import {
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
} from '../../bootstrap/runtime/runtimeContext.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { isAutoModeGateEnabled, shouldPlanUseAutoMode } from './autoModePolicy.js'
import {
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from './dangerousPermissionRules.js'
import { createDebugLog } from '../../services/infra/debug.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

const permLog = createDebugLog('permission-mode-transition')

/**
 * 处理切换权限模式时的所有状态转换。
 * 集中化副作用，使每条激活路径（CLI Shift+Tab、SDK 控制消息等）行为一致。
 *
 * 当前处理：
 * - 进入/退出 plan 模式的附件（通过 handlePlanModeTransition）
 * - auto 模式激活：setAutoModeActive、stripDangerousPermissionsForAutoMode
 *
 * 返回（可能已修改的）上下文。调用者负责在返回的上下文上设置模式。
 *
 * @param fromMode 当前权限模式
 * @param toMode 目标权限模式
 * @param context 当前工具权限上下文
 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  // plan→plan（SDK set_permission_mode）会错误地命中下方的 leave 分支
  if (fromMode === toMode) {
    return context
  }

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  if (toMode === 'plan' && fromMode !== 'plan') {
    return prepareContextForPlanMode(context)
  }

  // 带 auto 激活的 plan 模式算作使用了分类器（在离开侧）。
  // isAutoModeActive() 是权威信号 — prePlanMode/strippedDangerousRules
  // 是不可靠的代理，因为 auto 可以在 plan 中间被停用（非 opt-in
  // 进入、transitionPlanAutoMode），而这些字段仍然保持设置/未设置。
  const fromUsesClassifier =
    fromMode === 'auto' ||
    (fromMode === 'plan' && (autoModeStateModule?.isAutoModeActive() ?? false))
  const toUsesClassifier = toMode === 'auto' // plan 进入已在上方处理

  if (toUsesClassifier && !fromUsesClassifier) {
    if (!isAutoModeGateEnabled()) {
      throw new Error('Cannot transition to auto mode: gate is not enabled')
    }
    autoModeStateModule?.setAutoModeActive(true)
    context = stripDangerousPermissionsForAutoMode(context)
  } else if (fromUsesClassifier && !toUsesClassifier) {
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    context = restoreDangerousPermissions(context)
  }

  // 仅在有需要时才展开（保持引用相等性）
  if (fromMode === 'plan' && toMode !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }
  }

  return context
}

/**
 * 集中化的 plan 模式入口。将当前模式暂存为 prePlanMode，
 * 以便 ExitPlanMode 可以恢复它。当用户已 opt-in auto 模式时，
 * auto 语义在 plan 模式期间保持激活。
 */
export function prepareContextForPlanMode(context: ToolPermissionContext): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') {
    return context
  }
  const planAutoMode = shouldPlanUseAutoMode()
  if (currentMode === 'auto') {
    if (planAutoMode) {
      return { ...context, prePlanMode: 'auto' }
    }
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(context),
      prePlanMode: 'auto',
    }
  }
  if (planAutoMode && currentMode !== 'bypassPermissions') {
    autoModeStateModule?.setAutoModeActive(true)
    return {
      ...stripDangerousPermissionsForAutoMode(context),
      prePlanMode: currentMode,
    }
  }
  permLog(`[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`, {
    level: 'info',
  })
  return { ...context, prePlanMode: currentMode }
}

/**
 * 在设置更改后协调 plan 模式期间的 auto 模式状态。
 * 比较期望状态（shouldPlanUseAutoMode）与实际状态（isAutoModeActive），
 * 并相应地激活/停用 auto。不在 plan 模式时为无操作。
 * 从 applySettingsChange 调用，以便在 plan 中间切换 useAutoModeDuringPlan 立即生效。
 */
export function transitionPlanAutoMode(context: ToolPermissionContext): ToolPermissionContext {
  if (context.mode !== 'plan') {
    return context
  }
  // 与 prepareContextForPlanMode 的入口时排除条件保持一致 —
  // 当用户从危险模式进入时，永远不会在 plan 中间激活 auto。
  if (context.prePlanMode === 'bypassPermissions') {
    return context
  }

  const want = shouldPlanUseAutoMode()
  const have = autoModeStateModule?.isAutoModeActive() ?? false

  if (want && have) {
    // syncPermissionRulesFromDisk（在我们之前在 applySettingsChange 中调用）
    // 从磁盘重新添加危险规则，但不触碰 strippedDangerousRules。
    // 重新剥离，以免分类器被前缀规则放行匹配所绕过。
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (!want && !have) {
    return context
  }

  if (want) {
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
