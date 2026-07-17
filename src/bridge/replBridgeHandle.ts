import { updateSessionWireId } from '../services/session/concurrentSessions.js'
import type { ReplWireHandle } from './replBridge.js'
import { toCompatSessionId } from './sessionIdCompat.js'
/**
 * Global pointer to the active REPL bridge handle, so callers outside
 * useReplBridge's React tree (tools, slash commands) can invoke handle methods
 * like subscribePR. Same one-bridge-per-process justification as bridgeDebug.ts
 * — the handle's closure captures the sessionId and getAccessToken that created
 * the session, and re-deriving those independently (BriefTool/upload.ts pattern)
 * risks staging/prod token divergence.
 *
 * Set from useReplBridge.tsx when init completes; cleared on teardown.
 */

let handle: ReplWireHandle | null = null

export function setReplWireHandle(h: ReplWireHandle | null): void {
  handle = h
  // Publish (or clear) our bridge session ID in the session record so other
  // local peers can dedup us out of their bridge list — local is preferred.
  void updateSessionWireId(getSelfWireCompatId() ?? null).catch(() => {})
}

export function getReplWireHandle(): ReplWireHandle | null {
  return handle
}

/**
 * Our own bridge session ID in the session_* compat format the API returns
 * in /v1/sessions responses — or undefined if bridge isn't connected.
 */
export function getSelfWireCompatId(): string | undefined {
  const h = getReplWireHandle()
  return h ? toCompatSessionId(h.bridgeSessionId) : undefined
}
