/**
 * 子代理终端态清理、messages 释放与淘汰调度测试
 */
import { describe, expect, test } from 'bun:test'
import {
  completeAgentTask,
  failAgentTask,
  killAsyncAgent,
  type LocalAgentTaskState,
  scheduleTerminalEviction,
} from '../../src/tasks/local-agent-task/LocalAgentTask.js'
import { evictTerminalTask, registerTask } from '../../src/services/task-runtime/framework.js'
import { stopOrDismissAgent } from '../../src/state/teammateViewHelpers.js'
import type { AppState } from '../../src/state/AppStateStore.js'

function createMockState(): {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
} {
  let state = {
    tasks: {},
    viewingAgentTaskId: undefined,
    viewSelectionMode: 'none',
  } as unknown as AppState

  return {
    getState: () => state,
    setAppState: (updater) => {
      state = updater(state)
    },
  }
}

import { createTaskStateBase } from '../../src/tasks/task.js'

function createSampleTask(
  taskId: string,
  overrides?: Partial<LocalAgentTaskState>,
): LocalAgentTaskState {
  return {
    ...createTaskStateBase(taskId, 'local_agent', 'test agent'),
    type: 'local_agent',
    status: 'running',
    description: 'test agent',
    agentId: taskId,
    prompt: 'do something',
    agentType: 'General',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    messages: [
      {
        type: 'user',
        uuid: 'msg-1',
        message: { role: 'user', content: 'hello' },
      } as any,
    ],
    ...overrides,
  }
}

describe('LocalAgentTask eviction and memory cleanup', () => {
  test('completeAgentTask 应卸载 messages 并标记 completed', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-1')
    registerTask(task, setAppState)

    expect((getState().tasks['agent-1'] as LocalAgentTaskState | undefined)?.messages).toBeDefined()

    completeAgentTask(
      {
        agentId: 'agent-1',
        status: 'completed',
        content: 'result',
      } as any,
      setAppState,
    )

    const completed = getState().tasks['agent-1'] as LocalAgentTaskState
    expect(completed.status).toBe('completed')
    expect(completed.messages).toBeUndefined()
    expect(completed.evictAfter).toBeDefined()
  })

  test('completeAgentTask 当 retain=true 时应保留 messages', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-2', { retain: true })
    registerTask(task, setAppState)

    completeAgentTask(
      {
        agentId: 'agent-2',
        status: 'completed',
        content: 'result',
      } as any,
      setAppState,
    )

    const completed = getState().tasks['agent-2'] as LocalAgentTaskState
    expect(completed.status).toBe('completed')
    expect(completed.messages).toBeDefined()
  })

  test('failAgentTask 应卸载 messages 并标记 failed', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-fail')
    registerTask(task, setAppState)

    failAgentTask('agent-fail', 'some error', setAppState)

    const failed = getState().tasks['agent-fail'] as LocalAgentTaskState
    expect(failed.status).toBe('failed')
    expect(failed.messages).toBeUndefined()
  })

  test('killAsyncAgent 应卸载 messages 并标记 killed', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-kill')
    registerTask(task, setAppState)

    killAsyncAgent('agent-kill', setAppState)

    const killed = getState().tasks['agent-kill'] as LocalAgentTaskState
    expect(killed.status).toBe('killed')
    expect(killed.messages).toBeUndefined()
  })

  test('evictTerminalTask 在宽限期过期且已通知后应从 tasks 中彻底移除', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-evict', {
      status: 'completed',
      notified: true,
      evictAfter: Date.now() - 1000, // 宽限期已过
    })
    registerTask(task, setAppState)

    expect(getState().tasks['agent-evict']).toBeDefined()

    evictTerminalTask('agent-evict', setAppState)

    expect(getState().tasks['agent-evict']).toBeUndefined()
  })

  test('evictTerminalTask 在宽限期未到期时不应移除任务', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-grace', {
      status: 'completed',
      notified: true,
      evictAfter: Date.now() + 60_000, // 宽限期未过
    })
    registerTask(task, setAppState)

    evictTerminalTask('agent-grace', setAppState)

    expect(getState().tasks['agent-grace']).toBeDefined()
  })

  test('scheduleTerminalEviction 在延迟后能成功触发驱逐', async () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-timer', {
      status: 'completed',
      notified: true,
      evictAfter: Date.now() + 10,
    })
    registerTask(task, setAppState)

    scheduleTerminalEviction('agent-timer', setAppState, 20)

    expect(getState().tasks['agent-timer']).toBeDefined()

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(getState().tasks['agent-timer']).toBeUndefined()
  })

  test('stopOrDismissAgent 当任务处于终态且已通知时立即将其清除', () => {
    const { getState, setAppState } = createMockState()
    const task = createSampleTask('agent-dismiss', {
      status: 'completed',
      notified: true,
      evictAfter: Date.now() + 30_000,
    })
    registerTask(task, setAppState)

    stopOrDismissAgent('agent-dismiss', setAppState)

    expect(getState().tasks['agent-dismiss']).toBeUndefined()
  })
})
