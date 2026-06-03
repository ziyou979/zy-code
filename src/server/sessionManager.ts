/**
 * Session manager class
 */
export class SessionManager {
  constructor(_backend: unknown, _options?: { idleTimeoutMs?: number; maxSessions?: number }) {}

  async destroyAll(): Promise<void> {
    // Stub: destroy all active sessions
  }
}
