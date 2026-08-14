/**
 * InProcessTeammateTask：管理进程内 teammate 的生命周期。
 *
 * 此组件为进程内 teammate 实现 Task 接口。与 LocalAgentTask（后台 agent）不同，
 * 进程内 teammate：
 * 1. Run in the same Node.js process using AsyncLocalStorage for isolation
 * 2. Have team-aware identity (agentName@teamName)
 * 3. Support plan mode approval flow
 * 4. Can be idle (waiting for work) or active (processing)
 */

import { killInProcessTeammate } from '../../services/swarm/spawnInProcess.js'
import { updateTaskState } from '../../services/task-runtime/framework.js'
import {
  isTerminalTaskStatus,
  type SetAppState,
  type Task,
  type TaskStateBase,
} from '../../tasks/task.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { createUserMessage } from '../../services/messages/./constructors.js'
import type { InProcessTeammateTaskState } from './types.js'
import { appendCappedMessage, isInProcessTeammateTask } from './types.js'

/**
 * InProcessTeammateTask：处理进程内 teammate 的执行。
 */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    killInProcessTeammate(taskId, setAppState)
  },
}

/**
 * 请求关闭 teammate。
 */
export function requestTeammateShutdown(taskId: string, setAppState: SetAppState): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, (task) => {
    if (task.status !== 'running' || task.shutdownRequested) {
      return task
    }
    return {
      ...task,
      shutdownRequested: true,
    }
  })
}

/**
 * 向 teammate 的对话历史追加消息，供放大视图显示其对话。
 */
export function appendTeammateMessage(
  taskId: string,
  message: Message,
  setAppState: SetAppState,
): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, (task) => {
    if (task.status !== 'running') {
      return task
    }
    return {
      ...task,
      messages: appendCappedMessage(task.messages, message),
    }
  })
}

/**
 * 向 teammate 的待处理队列注入用户消息。查看 teammate transcript 时，
 * 用于向其发送输入的消息；同时把消息加入 task.messages，使其立即出现在 transcript 中。
 */
export function injectUserMessageToTeammate(
  taskId: string,
  message: string,
  setAppState: SetAppState,
): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, (task) => {
    // teammate 正在运行或空闲等待输入时允许注入消息，仅在终态时拒绝
    if (isTerminalTaskStatus(task.status)) {
      logForDebugging(
        `Dropping message for teammate task ${taskId}: task status is "${task.status}"`,
      )
      return task
    }
    return {
      ...task,
      pendingUserMessages: [...task.pendingUserMessages, message],
      messages: appendCappedMessage(
        task.messages,
        createUserMessage({
          content: [{ type: 'text' as const, text: message }],
        }),
      ),
    }
  })
}

/**
 * 按 agent ID 从 AppState 获取 teammate task。存在多个相同 agentId 的 task 时，
 * 优先返回运行中的 task，而非已终止或已完成者；找不到时返回 undefined。
 */
export function findTeammateTaskByAgentId(
  agentId: string,
  tasks: Record<string, TaskStateBase>,
): InProcessTeammateTaskState | undefined {
  let fallback: InProcessTeammateTaskState | undefined
  for (const task of Object.values(tasks)) {
    if (isInProcessTeammateTask(task) && task.identity.agentId === agentId) {
      // 若 AppState 中仍保留旧的已终止 task，且存在相同 agentId 的新运行 task，优先后者
      if (task.status === 'running') {
        return task
      }
      // 保留首个匹配项，在没有运行中 task 时作为回退
      if (!fallback) {
        fallback = task
      }
    }
  }
  return fallback
}

/**
 * 从 AppState 获取全部进程内 teammate task。
 */
export function getAllInProcessTeammateTasks(
  tasks: Record<string, TaskStateBase>,
): InProcessTeammateTaskState[] {
  return Object.values(tasks).filter(isInProcessTeammateTask)
}

/**
 * 获取运行中的进程内 teammate，并按 agentName 字母顺序排序。
 * TeammateSpinnerTree 展示、PromptInput 页脚选择器与 useBackgroundTaskNavigation
 * 共享此结果；selectedIPAgentIndex 会映射到该数组，因此三者必须采用相同排序。
 */
export function getRunningTeammatesSorted(
  tasks: Record<string, TaskStateBase>,
): InProcessTeammateTaskState[] {
  return getAllInProcessTeammateTasks(tasks)
    .filter((t) => t.status === 'running')
    .sort((a, b) => a.identity.agentName.localeCompare(b.identity.agentName))
}
