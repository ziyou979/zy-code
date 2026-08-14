// LocalShellTask 状态的纯类型定义和类型守卫。
// 从 LocalShellTask.tsx 中提取，避免非 React 调用方（如 print.ts 间接调用的 stopTask.ts）
// 将 React/Ink 引入模块依赖图。

import type { TaskStateBase } from '../../tasks/task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../services/shell/shellCommand.js'

export type BashTaskKind = 'bash' | 'monitor'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash' // 保持 local_bash，以兼容已持久化的会话状态
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  // 记录上次已上报的 TaskOutput 总行数，用于计算增量
  lastReportedTotalLines: number
  // 任务是否已转入后台（false 表示前台运行，true 表示后台运行）
  isBackgrounded: boolean
  // 启动该任务的 agent。agent 退出时据此终止孤立的 bash 任务，参见
  // killShellTasksForAgent；undefined 表示主线程。
  agentId?: AgentId
  // UI 展示变体。monitor 会以描述代替命令，使用 Monitor details 对话框标题和独立状态栏标记。
  kind?: BashTaskKind
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_bash'
}
