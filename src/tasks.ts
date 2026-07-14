import { feature } from 'bun:bundle'
import type { Task, TaskType } from './task.js'
import { DreamTask } from './tasks/dream-task/dreamTask.js'
import { LocalAgentTask } from './tasks/local-agent-task/LocalAgentTask.js'
import { LocalShellTask } from './tasks/local-shell-task/LocalShellTask.js'
import { RemoteAgentTask } from './tasks/remote-agent-task/RemoteAgentTask.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? require('./tasks/local-workflow-task/localWorkflowTask.js').LocalWorkflowTask
  : null
const MonitorMcpTask: Task | null = feature('MONITOR_TOOL')
  ? require('./tasks/monitor-mcp-task/monitorMcpTask.js').MonitorMcpTask
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask, RemoteAgentTask, DreamTask]
  if (LocalWorkflowTask) {
    tasks.push(LocalWorkflowTask)
  }
  if (MonitorMcpTask) {
    tasks.push(MonitorMcpTask)
  }
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find((t) => t.type === type)
}
