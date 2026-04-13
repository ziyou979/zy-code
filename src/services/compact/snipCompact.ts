// Stub for src/services/compact/snipCompact.ts

export type SnipResult = { snipped: boolean; content: string }

export function snipMessages(_messages: unknown[]): unknown[] {
  return _messages
}

export function shouldSnip(_messages: unknown[]): boolean {
  return false
}

export function isSnipMarkerMessage(message: { type: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'snip_marker'
}

export function isSnipRuntimeEnabled(): boolean {
  return false
}
