// 所有具体 task state 类型的联合，供需要处理任意 task 类型的组件使用

import type { DreamTaskState } from './dream-task/dreamTask.js'
import type { InProcessTeammateTaskState } from './in-process-teammate-task/types.js'
import type { LocalAgentTaskState } from './local-agent-task/LocalAgentTask.js'
import type { LocalShellTaskState } from './local-shell-task/guards.js'
import type { LocalWorkflowTaskState } from './local-workflow-task/localWorkflowTask.js'
import type { MonitorMcpTaskState } from './monitor-mcp-task/monitorMcpTask.js'
import type { RemoteAgentTaskState } from './remote-agent-task/RemoteAgentTask.js'

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

// 可出现在后台 task 指示器中的 task 类型
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

/**
 * 检查 task 是否应显示在后台 task 指示器中。
 * 满足以下条件时视为后台 task：
 * 1. It is running or pending
 * 2. It has been explicitly backgrounded (not a foreground task)
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  // 前台 task（isBackgrounded === false）尚不属于“后台 task”
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false
  }
  return true
}
