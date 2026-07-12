/**
 * 全局 agent 容量背压模块
 *
 * 在 spawn 时检查当前 resident/concurrent agent 数量，
 * 超限时 hibernate 最老的 idle agent。阻止无限 fire-and-forget 创建 runner。
 *
 * 不属于 src/utils/ 因为它涉及 agent 生命周期领域逻辑和 AppState 操作。
 */

import type { AppState } from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  MAX_CONCURRENT_IN_PROCESS_AGENTS,
  MAX_RESIDENT_AGENTS,
} from '../../tasks/InProcessTeammateTask/types.js'
import { logForDebugging } from '../../utils/debug.js'

export type CapacityCheckResult = {
  /** 是否可以继续 spawn */
  canSpawn: boolean
  /** 拒绝原因（canSpawn 为 false 时提供） */
  reason?: string
  /** 当前 resident agent 数量 */
  residentCount: number
  /** 当前正在运行的 agent 数量 */
  concurrentCount: number
}

/**
 * 计算当前 in-process agent 的容量使用情况。
 */
function countAgents(tasks: AppState['tasks']): {
  residentCount: number
  concurrentCount: number
  idleAgents: Array<{ taskId: string; idleSince: number }>
} {
  let residentCount = 0
  let concurrentCount = 0
  const idleAgents: Array<{ taskId: string; idleSince: number }> = []

  for (const task of Object.values(tasks)) {
    if (task?.type !== 'in_process_teammate') {
      continue
    }
    const ta = task as InProcessTeammateTaskState

    // resident: status 为 running（包括 idle 和 hibernated 前兆）
    if (ta.status === 'running') {
      residentCount++

      // concurrent: 正在工作（非 idle）
      if (!ta.isIdle) {
        concurrentCount++
      }

      // idle: 可以 hibernate 的候选
      if (ta.isIdle && ta.idleSince) {
        idleAgents.push({ taskId: ta.id, idleSince: ta.idleSince })
      }
    }
  }

  // 按 idleSince 升序（最老的在前）
  idleAgents.sort((a, b) => a.idleSince - b.idleSince)

  return { residentCount, concurrentCount, idleAgents }
}

/**
 * 检查是否可以 spawn 新的 agent。
 *
 * 在 spawnInProcessTeammate 调用前执行。
 * 如果超限，返回 canSpawn: false 及原因。
 * 调用方可根据 reason 决定是否 hibernate 最老的 idle agent 后重试。
 */
export function checkSpawnCapacity(getAppState: () => AppState): CapacityCheckResult {
  const state = getAppState()
  const { residentCount, concurrentCount, idleAgents } = countAgents(state.tasks ?? {})

  // 检查 concurrent 上限（正在工作的 agent）
  if (concurrentCount >= MAX_CONCURRENT_IN_PROCESS_AGENTS) {
    return {
      canSpawn: false,
      reason: `已达到最大并发 agent 数 (${MAX_CONCURRENT_IN_PROCESS_AGENTS})。请等待当前 agent 完成后重试。`,
      residentCount,
      concurrentCount,
    }
  }

  // 检查 resident 上限（包含 idle agent）
  if (residentCount >= MAX_RESIDENT_AGENTS) {
    // 如果有 idle agent，建议 hibernate 最老的
    if (idleAgents.length > 0) {
      const oldest = idleAgents[0]!
      logForDebugging(
        `[agentCapacity] Resident limit reached (${residentCount}/${MAX_RESIDENT_AGENTS}), oldest idle: ${oldest.taskId} (idle ${Math.round((Date.now() - oldest.idleSince) / 1000)}s)`,
      )
      // 当有可回收的 idle agent 时，仍然允许 spawn（由调用方决定是否 hibernate）
      return {
        canSpawn: true,
        residentCount,
        concurrentCount,
      }
    }

    // 所有 resident agent 都在工作中，拒绝
    return {
      canSpawn: false,
      reason: `已达到最大驻留 agent 数 (${MAX_RESIDENT_AGENTS})，且所有 agent 均在运行中。无法创建新 agent。`,
      residentCount,
      concurrentCount,
    }
  }

  return {
    canSpawn: true,
    residentCount,
    concurrentCount,
  }
}

/**
 * 获取可以被 hibernate 的最老 idle agent（用于容量回收）。
 * 如果没有可 hibernate 的 agent，返回 undefined。
 */
export function findOldestIdleAgent(
  getAppState: () => AppState,
): { taskId: string; idleDurationMs: number } | undefined {
  const state = getAppState()
  const { idleAgents } = countAgents(state.tasks ?? {})

  if (idleAgents.length === 0) {
    return undefined
  }

  const oldest = idleAgents[0]!
  return {
    taskId: oldest.taskId,
    idleDurationMs: Date.now() - oldest.idleSince,
  }
}
