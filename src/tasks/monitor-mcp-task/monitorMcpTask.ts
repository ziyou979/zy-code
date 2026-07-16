// Monitor MCP Task module stub implementation
// This module provides monitor task functionality for MONITOR_TOOL feature

import type { SetAppState, Task, TaskStateBase } from '../../tasks/Task.js'
import type { AgentId } from '../../types/ids.js'

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
  async kill(_taskId: string, _setAppState: SetAppState): Promise<void> {
    // Stub implementation - update task status to killed
    // In real implementation, this would terminate the monitor process
  },
}

/**
 * Kill a monitor MCP task
 * @param taskId - The task ID to kill
 * @param setAppState - State setter function
 */
export async function killMonitorMcp(_taskId: string, _setAppState: SetAppState): Promise<void> {
  // Stub implementation
}

/**
 * Kill all monitor MCP tasks for a specific agent
 * @param agentId - The agent ID
 * @param getAppState - State getter function
 * @param setAppState - State setter function
 */
export function killMonitorMcpTasksForAgent(
  _agentId: AgentId,
  _getAppState: () => unknown,
  _setAppState: SetAppState,
): void {
  // Stub implementation
}
