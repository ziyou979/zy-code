import { randomBytes } from 'node:crypto'
import { getTaskOutputPath } from './services/task-runtime/diskOutput.js'
import type { AppState } from './state/AppStateStore.js'
import type { AgentId } from './types/ids.js'

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

/**
 * 当任务处于终止状态时为 true，表示不会再发生状态转换。
 * 用于防止向已终止的 teammate 注入消息、从 AppState 中驱逐已完成的任务，以及孤儿清理路径。
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

export type SetAppState = (f: (prev: AppState) => AppState) => void

export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

// 所有任务状态共享的基础字段
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: AgentId
  /** UI 显示变体：描述作为标签、对话框标题、状态栏指示。 */
  kind?: 'bash' | 'monitor'
}

// getTaskByType 分发时所需的字段：kill。spawn/render 从未被多态调用（已在 #22546 中移除）。
// 所有六个 kill 实现仅使用 setAppState — getAppState/abortController 是冗余代码。
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}

// 任务 ID 前缀
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b', // 保持 'b' 以兼容旧数据
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

// 获取任务 ID 前缀
function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

// 用于任务 ID 的大小写不敏感字母表（数字 + 小写字母）。
// 36^8 ≈ 2.8 万亿种组合，足以抵御暴力符号链接攻击。
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
