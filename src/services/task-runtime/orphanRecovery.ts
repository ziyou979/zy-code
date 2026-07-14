/**
 * Orphan task 回收模块
 *
 * 扫描 in_progress 但 owner 已不活跃的 task，将其标记为 orphaned。
 * 防止 agent 崩溃、被 kill 或 session 恢复失败后 task 永久卡在 in_progress。
 *
 * 不属于 src/utils/ 因为它涉及 task 文件 I/O 和 agent 注册表领域逻辑。
 */

import type { AppState } from '../../state/AppStateStore.js'
import { getRunningTeammatesSorted } from '../../tasks/in-process-teammate-task/InProcessTeammateTask.js'
import { logForDebugging } from '../../utils/debug.js'
import { listTasks, updateTask } from '../../utils/tasks.js'

/** Orphan 判定宽限期（owner 消失后多久才标记为 orphaned） */
const ORPHAN_GRACE_MS = 5 * 60 * 1000 // 5 分钟

/**
 * 回收 orphan task。
 * 返回被回收的 task 数量。
 */
export async function recoverOrphanTasks(
  taskListId: string,
  getAppState: () => AppState,
): Promise<number> {
  try {
    const allTasks = await listTasks(taskListId)
    const now = Date.now()

    // 获取当前活跃的 in-process teammate 列表
    const state = getAppState()
    const activeAgentNames = getActiveAgentNames(state)

    let recoveredCount = 0

    for (const task of allTasks) {
      if (task.status !== 'in_progress') {
        continue
      }
      if (!task.owner) {
        continue
      }

      // 如果 owner 仍然活跃，跳过
      if (activeAgentNames.has(task.owner)) {
        continue
      }

      // 检查 updatedAt（task 没有独立的 updatedAt 字段，使用 metadata 替代）
      const updatedAt = task.metadata?.updatedAt
        ? new Date(task.metadata.updatedAt as string).getTime()
        : now
      const age = now - updatedAt
      if (age < ORPHAN_GRACE_MS) {
        continue
      }

      // 标记为 orphaned
      await updateTask(taskListId, task.id, {
        owner: undefined,
        status: 'pending',
        metadata: {
          ...(task.metadata ?? {}),
          orphanedAt: new Date().toISOString(),
          previousOwner: task.owner,
          orphanReason: 'owner_not_active',
        },
      })

      logForDebugging(
        `[orphanRecovery] Recovered task #${task.id} "${task.subject}" (previous owner: ${task.owner})`,
      )
      recoveredCount++
    }

    return recoveredCount
  } catch (err) {
    logForDebugging(`[orphanRecovery] Error: ${err}`)
    return 0
  }
}

/**
 * 获取当前活跃的 in-process teammate 名称集合。
 * 同时包含 agentName 和 agentId 两种格式。
 */
function getActiveAgentNames(state: AppState): Set<string> {
  const names = new Set<string>()

  for (const task of Object.values(state.tasks ?? {})) {
    if (task?.type === 'in_process_teammate' && task.status === 'running' && !task.isHibernated) {
      names.add(task.identity.agentName)
      names.add(task.identity.agentId)
    }
  }

  return names
}
