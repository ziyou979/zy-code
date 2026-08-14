// LocalShellTask 的纯终止辅助函数，不依赖 React。
// 将其提取后，runAgent.ts 无需把 React/Ink 引入模块依赖图即可终止 agent 范围内的 bash
// 任务；原因与 guards.ts 相同。

import { evictTaskOutput } from '../../services/task-runtime/diskOutput.js'
import { updateTaskState } from '../../services/task-runtime/framework.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logError } from '../../services/infra/log.js'
import { dequeueAllMatching } from '../../services/input/messageQueueManager.js'
import { isLocalShellTask } from './guards.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export function killTask(taskId: string, setAppState: SetAppStateFn): void {
  updateTaskState(taskId, setAppState, (task) => {
    if (task.status !== 'running' || !isLocalShellTask(task)) {
      return task
    }

    try {
      logForDebugging(`LocalShellTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }

    task.unregisterCleanup?.()
    if (task.cleanupTimeoutId) {
      clearTimeout(task.cleanupTimeoutId)
    }

    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * 终止指定 agent 启动的所有运行中 bash 任务。
 * 由 runAgent.ts 的 finally 块调用，避免后台进程在启动它的 agent 退出后继续存活，
 * 例如运行十天不退出的 fake-logs.sh 僵尸进程。
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (isLocalShellTask(task) && task.agentId === agentId && task.status === 'running') {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }
  // 清除队列中发给该 agent 的通知，因为其查询循环已经退出，不会再消费这些通知。
  // killTask 会异步发送 killed 通知；这里只移除已经入队的通知，之后到达的通知也不会产生
  // 影响，因为已退出的 agentId 不再有匹配的消费者。
  dequeueAllMatching((cmd) => cmd.agentId === agentId)
}
