// Monitor MCP 任务模块，为 MONITOR_TOOL 功能提供任务终止能力。

import type { SetAppState, Task, TaskStateBase } from '../../tasks/task.js'
import type { AgentId } from '../../types/ids.js'
import type { AppState } from '../../state/AppStateStore.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  agentId?: AgentId
  mcpServerName?: string
  error?: string
}

/**
 * 实现 Task 接口的 MonitorMcpTask。
 */
export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    await killMonitorMcp(taskId, setAppState)
  },
}

/**
 * 终止一个 Monitor MCP 任务。
 * @param taskId 要终止的任务 ID
 * @param setAppState 状态更新函数
 */
export async function killMonitorMcp(taskId: string, setAppState: SetAppState): Promise<void> {
  setAppState((state) => {
    const task = state.tasks[taskId]
    if (!task || task.type !== 'monitor_mcp' || task.status !== 'running') {
      return state
    }
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [taskId]: { ...task, status: 'killed', notified: true, endTime: Date.now() },
      },
    }
  })
}

/**
 * 终止指定 agent 的所有 Monitor MCP 任务。
 * @param agentId agent ID
 * @param getAppState 状态读取函数
 * @param setAppState 状态更新函数
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  for (const [taskId, task] of Object.entries(getAppState().tasks)) {
    if (task.type === 'monitor_mcp' && task.agentId === agentId && task.status === 'running') {
      void killMonitorMcp(taskId, setAppState)
    }
  }
}
