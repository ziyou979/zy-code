/**
 * Agent View blocked peek 摘要（问题优先 + waiting 时钟）
 */
import { describe, expect, test } from 'bun:test'
import { getBlockedPeekSummary } from '../../../src/components/agents/AgentSessionView.js'
import type { InProcessTeammateTaskState } from '../../../src/tasks/in-process-teammate-task/types.js'

function makeBlockedTask(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    type: 'in_process_teammate',
    status: 'running',
    identity: { agentId: 'a1', agentName: 'worker', teamName: 't', planModeRequired: false },
    awaitingPlanApproval: true,
    permissionMode: 'default',
    pendingUserMessages: [],
    lifecycleMode: 'persistent',
    isIdle: true,
    idleSince: 1_000_000_000_000,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    progress: {
      toolUseCount: 0,
      tokenCount: 0,
      summary: 'Approve the deploy plan?',
    },
    ...overrides,
  } as InProcessTeammateTaskState
}

describe('getBlockedPeekSummary', () => {
  test('以问题打头并附 waiting 时钟', () => {
    const task = makeBlockedTask()
    const now = 1_000_000_000_000 + 3 * 60_000
    const line = getBlockedPeekSummary(task, now)
    expect(line.startsWith('Approve the deploy plan?')).toBe(true)
    expect(line).toContain('waiting 3m')
    // 不应出现双重相同时间戳风格（仅一个 waiting）
    expect(line.match(/waiting/g)?.length).toBe(1)
  })

  test('非阻塞任务返回空', () => {
    const task = makeBlockedTask({
      awaitingPlanApproval: false,
      isIdle: false,
    })
    expect(getBlockedPeekSummary(task)).toBe('')
  })
})
