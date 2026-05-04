// Proactive mode module stub implementation
// This module provides proactive/autonomous mode functionality

let _proactiveActive = false
let _proactivePaused = false
let _contextBlocked = false
const _subscribers: Array<() => void> = []

/**
 * Check if proactive mode is currently active
 */
export function isProactiveActive(): boolean {
  return _proactiveActive
}

/**
 * Activate proactive mode
 * @param source - The source that triggered activation (e.g., 'command')
 */
export function activateProactive(source: string): void {
  _proactiveActive = true
  _proactivePaused = false
  _notifySubscribers()
}

/**
 * Deactivate proactive mode
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
 * Set context blocked state
 */
export function setContextBlocked(blocked: boolean): void {
  _contextBlocked = blocked
}

/**
 * Check if context is blocked
 */
export function isContextBlocked(): boolean {
  return _contextBlocked
}

/**
 * Subscribe to proactive mode changes
 * @param callback - Function to call when proactive state changes
 * @returns Unsubscribe function
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
