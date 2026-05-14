/**
 * 后台任务列表的类型定义和纯工具函数。
 * 从 BackgroundTasksDialog.tsx 中提取以减少文件体积。
 */

import type { DreamTaskState } from 'src/tasks/DreamTask/DreamTask.js'
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js'
// @ts-ignore — 类型导入，构建时擦除，模块可能不存在
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'
// @ts-ignore
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js'
import { type RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js'
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import type { DeepImmutable } from 'src/types/utils.js'

/** 后台任务列表展示项的联合类型 */
export type ListItem =
  | {
      id: string
      type: 'local_bash'
      label: string
      status: string
      task: DeepImmutable<LocalShellTaskState>
    }
  | {
      id: string
      type: 'remote_agent'
      label: string
      status: string
      task: DeepImmutable<RemoteAgentTaskState>
    }
  | {
      id: string
      type: 'local_agent'
      label: string
      status: string
      task: DeepImmutable<LocalAgentTaskState>
    }
  | {
      id: string
      type: 'in_process_teammate'
      label: string
      status: string
      task: DeepImmutable<InProcessTeammateTaskState>
    }
  | {
      id: string
      type: 'local_workflow'
      label: string
      status: string
      task: DeepImmutable<LocalWorkflowTaskState>
    }
  | {
      id: string
      type: 'monitor_mcp'
      label: string
      status: string
      task: DeepImmutable<MonitorMcpTaskState>
    }
  | {
      id: string
      type: 'dream'
      label: string
      status: string
      task: DeepImmutable<DreamTaskState>
    }
  | {
      id: string
      type: 'leader'
      label: string
      status: 'running'
    }

/** 将后台任务状态映射为统一的列表展示项 */
export function toListItem(task: BackgroundTaskState): ListItem {
  switch (task.type) {
    case 'local_bash':
      return {
        id: task.id,
        type: 'local_bash',
        label: task.kind === 'monitor' ? task.description : task.command,
        status: task.status,
        task,
      }
    case 'remote_agent':
      return {
        id: task.id,
        type: 'remote_agent',
        label: task.title,
        status: task.status,
        task,
      }
    case 'local_agent':
      return {
        id: task.id,
        type: 'local_agent',
        label: task.description,
        status: task.status,
        task,
      }
    case 'in_process_teammate':
      return {
        id: task.id,
        type: 'in_process_teammate',
        label: `@${task.identity.agentName}`,
        status: task.status,
        task,
      }
    case 'local_workflow':
      return {
        id: task.id,
        type: 'local_workflow',
        label: task.summary ?? task.description,
        status: task.status,
        task,
      }
    case 'monitor_mcp':
      return {
        id: task.id,
        type: 'monitor_mcp',
        label: task.description,
        status: task.status,
        task,
      }
    case 'dream':
      return {
        id: task.id,
        type: 'dream',
        label: task.description,
        status: task.status,
        task,
      }
  }
}

/** 获取过滤后的后台任务（排除已前置的 local_agent） */
export function getSelectableBackgroundTasks(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
): TaskState[] {
  const backgroundTasks = Object.values(tasks ?? {}).filter(isBackgroundTask)
  return backgroundTasks.filter(
    (task) => !(task.type === 'local_agent' && task.id === foregroundedTaskId),
  )
}
