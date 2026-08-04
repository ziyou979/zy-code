// Monitor MCP Task module stub implementation
// This module provides monitor task functionality for MONITOR_TOOL feature

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
 * MonitorMcpTask class implementing the Task interface
 */
export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    await killMonitorMcp(taskId, setAppState)
  },
}

/**
 * Kill a monitor MCP task
 * @param taskId - The task ID to kill
 * @param setAppState - State setter function
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
 * Kill all monitor MCP tasks for a specific agent
 * @param agentId - The agent ID
 * @param getAppState - State getter function
 * @param setAppState - State setter function
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
