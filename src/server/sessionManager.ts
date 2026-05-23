/**
 * Session manager class
 */
export class SessionManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_backend?: unknown, _options?: { idleTimeoutMs?: number; maxSessions?: number }) {}

  async destroyAll(): Promise<void> {
    // Stub: destroy all active sessions
  }
}
