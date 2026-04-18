// Proactive mode module stub implementation
// This module provides proactive/autonomous mode functionality

let _proactiveActive = false;
let _contextBlocked = false;
const _subscribers: Array<() => void> = [];

/**
 * Check if proactive mode is currently active
 */
export function isProactiveActive(): boolean {
  return _proactiveActive;
}

/**
 * Activate proactive mode
 * @param source - The source that triggered activation (e.g., 'command')
 */
export function activateProactive(source: string): void {
  _proactiveActive = true;
  _notifySubscribers();
}

/**
 * Deactivate proactive mode
 */
export function deactivateProactive(): void {
  _proactiveActive = false;
  _notifySubscribers();
}

/**
 * Set context blocked state
 */
export function setContextBlocked(blocked: boolean): void {
  _contextBlocked = blocked;
}

/**
 * Check if context is blocked
 */
export function isContextBlocked(): boolean {
  return _contextBlocked;
}

/**
 * Subscribe to proactive mode changes
 * @param callback - Function to call when proactive state changes
 * @returns Unsubscribe function
 */
export function subscribeToProactiveChanges(callback: () => void): () => void {
  _subscribers.push(callback);
  return () => {
    const index = _subscribers.indexOf(callback);
    if (index > -1) {
      _subscribers.splice(index, 1);
    }
  };
}

function _notifySubscribers(): void {
  _subscribers.forEach(cb => cb());
}
