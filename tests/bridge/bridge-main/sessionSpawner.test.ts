/**
 * sessionSpawner 特性测试。
 */
import { describe, expect, test } from 'bun:test'
import { safeSpawn } from '../../../src/bridge/bridge-main/sessionSpawner.js'
import type { SessionHandle, SessionSpawner, SessionSpawnOpts } from '../../../src/bridge/types.js'
import type { SessionDoneStatus } from '../../../src/bridge/types.js'

function createMockHandle(): SessionHandle {
  return {
    sessionId: 'mock-session',
    done: new Promise<SessionDoneStatus>(() => {}),
    kill: () => {},
    forceKill: () => {},
    activities: [],
    currentActivity: null,
    accessToken: 'mock-token',
    lastStderr: [],
    writeStdin: () => {},
    updateAccessToken: () => {},
  }
}

function createMockSpawner(handler: () => SessionHandle | never): SessionSpawner {
  return { spawn: () => handler() }
}

const mockOpts: SessionSpawnOpts = {
  sessionId: 'mock-session',
  sdkUrl: 'http://localhost:8080',
  accessToken: 'mock-token',
}

describe('safeSpawn', () => {
  test('spawn 成功返回 SessionHandle', () => {
    const handle = createMockHandle()
    const spawner = createMockSpawner(() => handle)
    const result = safeSpawn(spawner, mockOpts, '/tmp')
    expect(result).toBe(handle)
  })

  test('spawn 抛出错误时返回错误消息', () => {
    const spawner = createMockSpawner(() => {
      throw new Error('connection refused')
    })
    const result = safeSpawn(spawner, mockOpts, '/tmp')
    expect(typeof result).toBe('string')
    expect(result).toContain('connection refused')
  })

  test('spawn 抛出非 Error 类型时也能捕获', () => {
    const spawner = createMockSpawner(() => {
      throw 'string error'
    })
    const result = safeSpawn(spawner, mockOpts, '/tmp')
    expect(typeof result).toBe('string')
  })
})
