import { feature } from 'bun:bundle'
import type { Task, TaskType } from '../tasks/task.js'
import { DreamTask } from './dream-task/dreamTask.js'
import { LocalAgentTask } from './local-agent-task/LocalAgentTask.js'
import { LocalShellTask } from './local-shell-task/LocalShellTask.js'
import { RemoteAgentTask } from './remote-agent-task/RemoteAgentTask.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? require('./local-workflow-task/localWorkflowTask.js').LocalWorkflowTask
  : null
const MonitorMcpTask: Task | null = feature('MONITOR_TOOL')
  ? require('./monitor-mcp-task/monitorMcpTask.js').MonitorMcpTask
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 获取全部 task。
 * 沿用 tools.ts 的模式；直接返回内联数组，避免顶层 const 引发循环依赖问题。
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
 * 按类型获取 task。
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find((t) => t.type === type)
}
