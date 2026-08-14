import type { TaskStateBase } from '../../tasks/task.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../services/permissions/permissionMode.js'
import type { AgentProgress } from '../local-agent-task/LocalAgentTask.js'

/**
 * 任务状态中保存的 teammate 身份。其结构与运行时 TeammateContext 相同，但这里只存储普通数据；
 * TeammateContext 供 AsyncLocalStorage 使用，此类型则用于 AppState 持久化。
 *
 * Agent 生命周期模式
 * - ephemeral: 完成当前 assignment 后终止，不进入 idle 等待
 * - persistent: 作为团队成员保持存活，支持 idle/hibernate
 */
export type AgentLifecycleMode = 'ephemeral' | 'persistent'

export type TeammateIdentity = {
  agentId: string // 例如 "researcher@my-team"
  agentName: string // 例如 "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string // leader 的会话 ID
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // 将身份保存为子对象，以便与 TeammateContext 的结构保持一致。
  // AppState 中存储的是普通数据，不是对 AsyncLocalStorage 的引用。
  identity: TeammateIdentity

  // 执行信息
  prompt: string
  // 可选的 teammate 模型覆盖值
  model?: string
  // 可选：仅在 teammate 使用特定 agent 定义时设置。
  // 许多 teammate 会作为 General agent 运行，没有预定义配置。
  selectedAgent?: AgentDefinition
  abortController?: AbortController // 仅用于运行时，不写入磁盘；终止整个 teammate
  currentWorkAbortController?: AbortController // 仅用于运行时；中止当前轮次但不终止 teammate
  unregisterCleanup?: () => void // 仅用于运行时

  // 跟踪 Plan mode 审批状态；planModeRequired 位于 identity 中
  awaitingPlanApproval: boolean

  // 此 teammate 的权限模式；查看时可通过 Shift+Tab 独立切换
  permissionMode: PermissionMode

  // 状态
  error?: string
  result?: AgentToolResult // teammate 通过 runAgent() 运行，因此复用现有类型
  progress?: AgentProgress

  // 放大视图中的对话历史，不包含 mailbox 消息。
  // mailbox 消息另存于 teamContext.inProcessMailboxes。
  messages?: Message[]

  // 当前正在执行的工具调用 ID，用于 transcript 视图动画
  inProgressToolUseIDs?: Set<string>

  // 查看 teammate transcript 时待投递的用户消息队列
  pendingUserMessages: string[]

  // UI 使用的随机 spinner 动词；重新渲染时保持稳定，并由组件共享
  spinnerVerb?: string
  pastTenseVerb?: string

  // 当前领取的 task assignment（用于 idle reconciliation）
  currentAssignment?: ClaimedTaskAssignment
  // 生命周期
  lifecycleMode: AgentLifecycleMode
  isIdle: boolean
  /** 进入 idle 状态的时间戳（用于 TTL 计算） */
  idleSince?: number
  /** 是否已进入 idle-compact 阶段 */
  isIdleCompact?: boolean
  /** 是否已进入 hibernated 状态（runner 已退出） */
  isHibernated?: boolean
  /** hibernate 时的快照路径 */
  hibernationSnapshotPath?: string
  shutdownRequested: boolean

  // teammate 进入 idle 时触发的回调，仅用于运行时。
  // leader 借此高效等待，无需轮询。
  onIdleCallbacks?: Array<() => void>

  // 跟踪进度，用于计算通知中的增量
  lastReportedToolCount: number
  lastReportedTokenCount: number
}

export function isInProcessTeammateTask(task: unknown): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * task.messages（AppState 的 UI 镜像）所保留的消息数上限。
 *
 * task.messages 仅供放大的 transcript 对话框使用，只需保留近期上下文。完整对话保存在
 * inProcessRunner 的本地 allMessages 数组以及 agent transcript 对应的磁盘文件中。
 *
 * BQ 第 9 轮分析（2026-03-20）显示，超过 500 轮的会话中每个 agent 约占 20MB RSS，swarm
 * 突发并发时每个 agent 约占 125MB。超大会话 9a990de8 在 2 分钟内启动 292 个 agent，内存
 * 达到 36.8GB；主要开销正是该数组为每条消息保留了第二份完整副本。
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/**
 * Agent history 三重预算默认值
 */
export const AGENT_HISTORY_MAX_MESSAGES = 120
export const AGENT_HISTORY_MAX_BYTES = 24 * 1024 * 1024
export const AGENT_IDLE_HISTORY_MAX_BYTES = 4 * 1024 * 1024

/**
 * Agent 容量背压默认值
 */
export const MAX_CONCURRENT_IN_PROCESS_AGENTS = 8
export const MAX_PERSISTENT_TEAMMATES = 16
export const MAX_RESIDENT_AGENTS = 24
export const MAX_ESTIMATED_RESIDENT_BYTES = 512 * 1024 * 1024

/**
 * 工具结果外置阈值（单条超过此大小则写入磁盘）
 */
export const TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES = 512 * 1024 // 512 KB

/**
 * idle 分层 TTL
 */
export const IDLE_HOT_MS = 60_000
export const IDLE_COMPACT_MS = 10 * 60_000 // 10 分钟后进入 hibernate

/**
 * Agent history 预算配置
 */
export type AgentHistoryBudget = {
  maxMessages: number
  maxTokens: number
  maxBytes: number
}

/**
 * Agent history 运行时状态快照
 */
export type AgentHistoryState = {
  recentMessages: import('../../types/message.js').Message[]
  compactedMessages: import('../../types/message.js').Message[]
  estimatedTokens: number
  estimatedBytes: number
  rawToolResultBytes: number
}

/** 结构化 task assignment（runner 在当前轮次中领取的任务）。 */
export type ClaimedTaskAssignment = {
  taskListId: string
  taskId: string
  owner: string
  claimToken: string
  claimedAt: number
  version: number
}

/** Stored tool result reference（工具结果外置时使用）。 */
export type StoredToolResultReference = {
  type: 'stored_tool_result'
  toolCallId: string
  path: string
  byteLength: number
  preview: string
  digest?: string
}

/**
 * Hibernated agent snapshot（hibernate 时保存的恢复信息）
 * runner 退出后，用此快照在收到新消息时重建 runner。
 */
export type HibernatedAgentSnapshot = {
  identity: TeammateIdentity
  model?: string
  permissionMode: import('../../services/permissions/permissionMode.js').PermissionMode
  /** hibernate 时的摘要消息（用于 resume 时提供上下文） */
  summary: import('../../types/message.js').Message[]
  /** 完整 transcript 磁盘路径 */
  transcriptPath: string
  /** 最后活动时间 */
  lastActiveAt: number
  /** hibernate 时间 */
  hibernatedAt: number
  /** 生命周期模式（恢复时沿用） */
  lifecycleMode: AgentLifecycleMode
  /** 本次 hibernate 的唯一标识，用于校验 resume 合法性 */
  snapshotVersion: number
}

/**
 * 向消息数组追加一项；超过 TEAMMATE_MESSAGES_UI_CAP 时丢弃最旧项。始终返回新数组，
 * 以保持 AppState 不可变。
 */
export function appendCappedMessage<T>(prev: readonly T[] | undefined, item: T): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
