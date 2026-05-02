/**
 * Server lockfile utilities
 */

export interface ServerLockInfo {
  pid: number
  port?: number
  host?: string
  httpUrl: string
  startedAt?: number
  [key: string]: unknown
}

export async function writeServerLock(info: ServerLockInfo): Promise<void> {
  throw new Error('writeServerLock not implemented')
}

export async function removeServerLock(): Promise<void> {
  throw new Error('removeServerLock not implemented')
}

export async function probeRunningServer(): Promise<ServerLockInfo | null> {
  throw new Error('probeRunningServer not implemented')
}
