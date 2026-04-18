// Assistant mode module stub implementation
// This module provides KAIROS assistant mode functionality

let _assistantMode = false;

/**
 * Check if assistant mode is currently active
 */
export function isAssistantMode(): boolean {
  return _assistantMode;
}

/**
 * Enable assistant mode
 */
export function enableAssistantMode(): void {
  _assistantMode = true;
}

/**
 * Disable assistant mode
 */
export function disableAssistantMode(): void {
  _assistantMode = false;
}
