// Proactive mode module stub implementation
// This module provides proactive/autonomous mode functionality

let _proactiveActive = false
let _proactivePaused = false
let _contextBlocked = false
const _subscribers: Array<() => void> = []

/**
 * 检查主动模式当前是否已启用。
 */
export function isProactiveActive(): boolean {
  return _proactiveActive
}

/**
 * 启用主动模式。
 * @param source 触发启用的来源，例如 'command'
 */
export function activateProactive(_source: string): void {
  _proactiveActive = true
  _proactivePaused = false
  _notifySubscribers()
}

/**
 * 停用主动模式。
 */
export function deactivateProactive(): void {
  _proactiveActive = false
  _proactivePaused = false
  _notifySubscribers()
}

/** 暂停 proactive mode（保留状态，临时静默） */
export function pauseProactive(): void {
  _proactivePaused = true
}

/** 恢复之前暂停的 proactive mode */
export function resumeProactive(): void {
  _proactivePaused = false
}

/** 检查 proactive mode 是否处于暂停状态 */
export function isProactivePaused(): boolean {
  return _proactivePaused
}

/**
 * 设置上下文阻塞状态。
 */
export function setContextBlocked(blocked: boolean): void {
  _contextBlocked = blocked
}

/**
 * 检查上下文是否处于阻塞状态。
 */
export function isContextBlocked(): boolean {
  return _contextBlocked
}

/**
 * 订阅主动模式的状态变化。
 * @param callback 状态变化时调用的函数
 * @returns 取消订阅函数
 */
export function subscribeToProactiveChanges(callback: () => void): () => void {
  _subscribers.push(callback)
  return () => {
    const index = _subscribers.indexOf(callback)
    if (index > -1) {
      _subscribers.splice(index, 1)
    }
  }
}

function _notifySubscribers(): void {
  _subscribers.forEach((cb) => cb())
}
