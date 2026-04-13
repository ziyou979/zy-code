/**
 * 从 AppState 派生计算状态的 selector。
 * 保持 selector 纯粹简单 - 仅数据提取，无副作用。
 */

import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

/**
 * 获取当前正在查看的 teammate task（如果有）。
 * 在以下情况下返回 undefined：
 * - 没有正在查看的 teammate（viewingAgentTaskId 为 undefined）
 * - task ID 在 tasks 中不存在
 * - task 不是进行中的 teammate task
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState

  // 没有查看任何 teammate
  if (!viewingAgentTaskId) {
    return undefined
  }

  // 查找该 task
  const task = tasks[viewingAgentTaskId]
  if (!task) {
    return undefined
  }

  // 验证它是进行中的 teammate task
  if (!isInProcessTeammateTask(task)) {
    return undefined
  }

  return task
}

/**
 * getActiveAgentForInput selector 的返回类型。
 * 判别联合类型，用于类型安全的输入路由。
 */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * 确定用户输入应该路由到哪里。
 * 返回：
 * - { type: 'leader' } 当没有查看 teammate 时（输入发送给 leader）
 * - { type: 'viewed', task } 当查看 agent 时（发送给该 agent）
 *
 * 由输入路由逻辑使用，将用户消息定向到正确的 agent。
 */
export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) {
    return { type: 'viewed', task: viewedTask }
  }

  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') {
      return { type: 'named_agent', task }
    }
  }

  return { type: 'leader' }
}
