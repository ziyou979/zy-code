/**
 * agentCapacity 测试：验证容量计算逻辑和边界条件。
 */
import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../../src/state/AppState.js'
import {
  checkSpawnCapacity,
  findOldestIdleAgent,
} from '../../../src/services/swarm/agentCapacity.js'
import {
  MAX_CONCURRENT_IN_PROCESS_AGENTS,
  MAX_RESIDENT_AGENTS,
} from '../../../src/tasks/InProcessTeammateTask/types.js'

/**
 * 构造最小 mock AppState，包含指定的 in_process_teammate tasks。
 */
function mockState(
  tasks: Array<{
    id: string
    status: string
    isIdle?: boolean
    idleSince?: number
  }>,
): AppState {
  const taskMap: Record<string, any> = {}
  for (const t of tasks) {
    taskMap[t.id] = {
      id: t.id,
      type: 'in_process_teammate',
      status: t.status,
      isIdle: t.isIdle ?? false,
      idleSince: t.idleSince,
      identity: { agentId: t.id, agentName: t.id, teamName: 'test' },
      prompt: '',
      lifecycleMode: 'ephemeral',
      permissionMode: 'default',
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      startTime: Date.now(),
    }
  }
  return { tasks: taskMap } as unknown as AppState
}

describe('checkSpawnCapacity', () => {
  test('空状态可以 spawn', () => {
    const state = mockState([])
    const result = checkSpawnCapacity(() => state)
    expect(result.canSpawn).toBe(true)
    expect(result.residentCount).toBe(0)
    expect(result.concurrentCount).toBe(0)
  })

  test('resident 未超限时可以 spawn', () => {
    const tasks = []
    for (let i = 0; i < MAX_RESIDENT_AGENTS - 1; i++) {
      tasks.push({
        id: `agent-${i}`,
        status: 'running',
        isIdle: true,
        idleSince: Date.now() - 60000,
      })
    }
    const state = mockState(tasks)
    const result = checkSpawnCapacity(() => state)
    expect(result.canSpawn).toBe(true)
    expect(result.residentCount).toBe(MAX_RESIDENT_AGENTS - 1)
  })

  test('resident 超限但有 idle agent 时允许 spawn', () => {
    const tasks = []
    for (let i = 0; i < MAX_RESIDENT_AGENTS; i++) {
      tasks.push({
        id: `agent-${i}`,
        status: 'running',
        isIdle: true,
        idleSince: Date.now() - 60000,
      })
    }
    const state = mockState(tasks)
    const result = checkSpawnCapacity(() => state)
    // 有 idle agent 可回收，允许 spawn
    expect(result.canSpawn).toBe(true)
    expect(result.residentCount).toBe(MAX_RESIDENT_AGENTS)
  })

  test('concurrent 超限时拒绝 spawn', () => {
    const tasks = []
    for (let i = 0; i < MAX_CONCURRENT_IN_PROCESS_AGENTS; i++) {
      tasks.push({ id: `agent-${i}`, status: 'running', isIdle: false })
    }
    const state = mockState(tasks)
    const result = checkSpawnCapacity(() => state)
    expect(result.canSpawn).toBe(false)
    expect(result.reason).toContain('并发')
  })

  test('resident + concurrent 同时超限时优先返回 concurrent 错误', () => {
    const tasks = []
    for (let i = 0; i < MAX_CONCURRENT_IN_PROCESS_AGENTS; i++) {
      tasks.push({ id: `agent-${i}`, status: 'running', isIdle: false })
    }
    const state = mockState(tasks)
    const result = checkSpawnCapacity(() => state)
    expect(result.canSpawn).toBe(false)
    expect(result.reason).toContain('并发')
  })

  test('resident 超限、concurrent 未超限且无 idle agent 时拒绝 spawn', () => {
    // 纯 idle agent 不占用 concurrent slot，但占用 resident slot
    const tasks = []
    // 先填满 concurrent 限制-1（留 1 个 slot），每个运行 agent 也计入 resident
    for (let i = 0; i < MAX_CONCURRENT_IN_PROCESS_AGENTS - 1; i++) {
      tasks.push({ id: `running-${i}`, status: 'running', isIdle: false })
    }
    // 剩余 resident 用纯 idle agent 填充，不含 idleSince 字段（模拟无 idle 记录）
    // 由于 concurrent 未超限，检查进入 resident 判断
    for (let i = tasks.length; i < MAX_RESIDENT_AGENTS + 1; i++) {
      tasks.push({ id: `old-idle-${i}`, status: 'running', isIdle: true })
    }
    const state = mockState(tasks)
    const result = checkSpawnCapacity(() => state)
    // resident 超出限制，且所有 idle agent 都没有 idleSince（不可回收）
    expect(result.canSpawn).toBe(false)
  })

  test('只统计 in_process_teammate 类型', () => {
    const state = {
      tasks: {
        'local-1': {
          id: 'local-1',
          type: 'local_agent',
          status: 'running',
          agentType: 'Explore',
          startTime: Date.now(),
        },
      },
    } as unknown as AppState
    const result = checkSpawnCapacity(() => state)
    expect(result.canSpawn).toBe(true)
    expect(result.residentCount).toBe(0)
  })

  test('找不到对应 task 时 safe', () => {
    const state = mockState([])
    const oldest = findOldestIdleAgent(() => state)
    expect(oldest).toBeUndefined()
  })

  test('非 idle agent 不被返回为可回收', () => {
    const state = mockState([
      { id: 'busy', status: 'running', isIdle: false },
      { id: 'idle-one', status: 'running', isIdle: true, idleSince: Date.now() - 120000 },
    ])
    const oldest = findOldestIdleAgent(() => state)
    expect(oldest).toBeDefined()
    expect(oldest!.taskId).toBe('idle-one')
  })
})
