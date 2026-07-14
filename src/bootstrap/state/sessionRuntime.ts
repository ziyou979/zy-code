// sessionRuntime 领域的运行时状态访问器。

import { STATE } from './core.js'

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export function getSessionCronTasks() {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: (typeof STATE.sessionCronTasks)[number]): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * 返回实际移除的任务数量。调用者使用此值跳过
 * 下游工作（例如 removeCronTasks 中的磁盘读取），当所有 id
 * 都已在此处理时。
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) {
    return 0
  }
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter((t) => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) {
    return 0
  }
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(fromMode: string, toMode: string): void {
  // 切换到计划模式时，清除任何待处理的退出附件
  // 这防止用户快速切换时同时发送 plan_mode 和 plan_mode_exit
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // 退出计划模式时，触发 plan_mode_exit 附件
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(fromMode: string, toMode: string): void {
  // 自动↔计划模式的切换由 prepareContextForPlanMode 处理
  //（如果选择加入，自动模式可能在计划模式中保持活跃）
  // 和 ExitPlanMode（恢复模式）。跳过两个方向，因此
  // 此函数仅处理直接的自动模式切换。
  if ((fromMode === 'auto' && toMode === 'plan') || (fromMode === 'plan' && toMode === 'auto')) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // 切换到自动模式时，清除任何待处理的退出附件
  // 这防止用户快速切换时同时发送 auto_mode 和 auto_mode_exit
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // 退出自动模式时，触发 auto_mode_exit 附件
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP 插件推荐会话追踪
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK init event state
