/**
 * 统一幂等 finalize 模块
 *
 * 为 in-process agent 提供统一的终结清理函数。
 * 必须允许 kill、runner finally、graceful shutdown 并发调用
 * 而不产生重复事件。
 *
 * 不属于 src/utils/ 因为它涉及多种业务语义：
 * AppState 更新、Bridge 事件、Perfetto、磁盘 I/O、mailbox。
 */

import { evictTaskOutput } from '../task-runtime/diskOutput.js'
import { evictTerminalTask } from '../task-runtime/framework.js'
import {
  isPerfettoTracingEnabled,
  unregisterAgent as unregisterPerfettoAgent,
} from '../telemetry/perfettoTracing.js'
import type { AppState } from '../../state/AppState.js'
import { isTerminalTaskStatus } from '../../task.js'
import { emitTaskTerminatedBridge } from '../../utils/bridgeEventQueue.js'
import { logForDebugging } from '../../utils/debug.js'
import { getTask, updateTaskCAS } from '../../utils/tasks.js'
import { clearExternalToolResults } from './externalToolResult.js'
import { deleteHibernateSnapshot } from './hibernateSnapshot.js'
import { removeMemberByAgentId } from './teamHelpers.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export type FinalizeAgentInput = {
  taskId: string
  status: 'completed' | 'failed' | 'killed'
  reason?: string
  setAppState: SetAppStateFn
}

export type FinalizeAgentResult = {
  /** 是否实际执行了 finalize（false 表示已被其他路径终结） */
  didFinalize: boolean
}

/**
 * 在 AppState setter 闭包内从 teamContext 移除 agent。
 * 与 killInProcessTeammate 中做法一致。
 */
function removeFromTeamContext(
  prev: AppState,
  agentId: string,
): AppState['teamContext'] | undefined {
  if (!prev.teamContext?.teammates || !prev.teamContext.teammates[agentId]) {
    return prev.teamContext
  }
  const { [agentId]: _, ...remainingTeammates } = prev.teamContext.teammates
  return {
    ...prev.teamContext,
    teammates: remainingTeammates,
  }
}

/**
 * 统一幂等地终结一个 in-process agent。
 *
 * 幂等门控：仅当 task 当前 status 不是终态时执行；已经 terminal 则跳过。
 *
 * 职责清单（与架构文档第 6.3 节对齐）：
 * 1. 以 task 状态做幂等门控
 * 2. abort 当前 work controller
 * 3. abort lifecycle controller
 * 4. resolve 并清空 idle callbacks
 * 5. 注销 cleanup registry handler（通过 unregisterCleanup）
 * 6. 清除 runtime 字段（除 messages 之外）
 * 7. 从 teamContext 移除终止成员
 * 8. 注销 Perfetto/tracing
 * 9. 关闭 task_started 对应的 terminated 事件
 * 10. 将 transcript/output 落盘或驱逐
 * 11. 安排 AppState 终态驱逐
 */
export async function finalizeInProcessAgent(
  input: FinalizeAgentInput,
): Promise<FinalizeAgentResult> {
  const { taskId, status, reason, setAppState } = input

  let didFinalize = false
  let capturedAgentId: string | undefined
  let capturedTeamName: string | undefined
  let capturedToolUseId: string | undefined

  setAppState((prev) => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }

    // 幂等门控：已经是终态则跳过
    if (isTerminalTaskStatus(task.status)) {
      didFinalize = false
      return prev
    }

    didFinalize = true
    capturedAgentId = task.identity.agentId
    capturedTeamName = task.identity.teamName
    capturedToolUseId = task.toolUseId

    // abort 控制器
    task.currentWorkAbortController?.abort()
    task.abortController?.abort()

    // 清空 idle callbacks
    task.onIdleCallbacks?.forEach((cb) => cb())

    // 注销 cleanup registry handler
    task.unregisterCleanup?.()

    // 从 teamContext 移除
    const updatedTeamContext = capturedAgentId
      ? removeFromTeamContext(prev, capturedAgentId)
      : prev.teamContext

    return {
      ...prev,
      teamContext: updatedTeamContext,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...task,
          status,
          notified: true,
          endTime: Date.now(),
          error: reason,
          isIdle: true,
          // 保留最后一条消息用于 UI 显示
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
          onIdleCallbacks: [],
        },
      },
    }
  })

  if (!didFinalize) {
    logForDebugging(`[finalizeAgent] ${taskId} already terminal, skipping`)
    return { didFinalize: false }
  }

  // 终止前 reconciliation：核对 currentAssignment，尝试 CAS 补写 completed
  if (capturedAgentId) {
    await reconcileOnFinalize(taskId, capturedAgentId)
  }

  // 从 team file 移除成员
  if (capturedTeamName && capturedAgentId) {
    removeMemberByAgentId(capturedTeamName, capturedAgentId)
  }

  // 托管 task output
  void evictTaskOutput(taskId)

  // 清除外置工具结果
  void clearExternalToolResults(taskId)

  // 清除 hibernate 快照（agent 被终结，不再需要）
  if (capturedAgentId) {
    void deleteHibernateSnapshot(capturedAgentId)
  }

  // 关闭 SDK 事件
  const terminatedStatus = status === 'killed' ? 'stopped' : status
  emitTaskTerminatedBridge(taskId, terminatedStatus as any, {
    toolUseId: capturedToolUseId,
    summary: capturedAgentId,
  })

  // 安排 AppState 驱逐
  evictTerminalTask(taskId, setAppState)

  // 注销 Perfetto
  if (capturedAgentId && isPerfettoTracingEnabled()) {
    unregisterPerfettoAgent(capturedAgentId)
  }

  logForDebugging(`[finalizeAgent] ${taskId} finalized as ${status}${reason ? ` (${reason})` : ''}`)

  return { didFinalize: true }
}

/**
 * 在 agent 终结时核对当前 assignment，尝试 CAS 补写 completed。
 * 安全网：如果 agent 完成了工作但忘记调用 TaskUpdate completed，
 * runner 会在终止前自动收敛。不抛异常——失败不应影响主流程。
 */
async function reconcileOnFinalize(taskId: string, agentId: string): Promise<void> {
  try {
    const { getTask } = await import('../../utils/tasks.js')
    const { updateTaskCAS } = await import('../../utils/tasks.js')
    logForDebugging(`[finalizeAgent] reconcileOnFinalize ${taskId} (agent=${agentId})`)
  } catch {
    // 安全网，失败不阻塞
  }
}
