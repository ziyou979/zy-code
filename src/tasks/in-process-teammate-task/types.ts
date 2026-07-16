import type { TaskStateBase } from '../../tasks/Task.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../services/permissions/permissionMode.js'
import type { AgentProgress } from '../local-agent-task/LocalAgentTask.js'

/**
 * Teammate identity stored in task state.
 * Same shape as TeammateContext (runtime) but stored as plain data.
 * TeammateContext is for AsyncLocalStorage; this is for AppState persistence.
 */
/**
 * Agent 生命周期模式
 * - ephemeral: 完成当前 assignment 后终止，不进入 idle 等待
 * - persistent: 作为团队成员保持存活，支持 idle/hibernate
 */
export type AgentLifecycleMode = 'ephemeral' | 'persistent'

export type TeammateIdentity = {
  agentId: string // e.g., "researcher@my-team"
  agentName: string // e.g., "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string // Leader's session ID
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // Identity as sub-object (matches TeammateContext shape for consistency)
  // Stored as plain data in AppState, NOT a reference to AsyncLocalStorage
  identity: TeammateIdentity

  // Execution
  prompt: string
  // Optional model override for this teammate
  model?: string
  // Optional: Only set if teammate uses a specific agent definition
  // Many teammates run as General agents without a predefined definition
  selectedAgent?: AgentDefinition
  abortController?: AbortController // Runtime only, not serialized to disk - kills WHOLE teammate
  currentWorkAbortController?: AbortController // Runtime only - aborts current turn without killing teammate
  unregisterCleanup?: () => void // Runtime only

  // Plan mode approval tracking (planModeRequired is in identity)
  awaitingPlanApproval: boolean

  // Permission mode for this teammate (cycled independently via Shift+Tab when viewing)
  permissionMode: PermissionMode

  // State
  error?: string
  result?: AgentToolResult // Reuse existing type since teammates run via runAgent()
  progress?: AgentProgress

  // Conversation history for zoomed view (NOT mailbox messages)
  // Mailbox messages are stored separately in teamContext.inProcessMailboxes
  messages?: Message[]

  // Tool use IDs currently being executed (for animation in transcript view)
  inProgressToolUseIDs?: Set<string>

  // Queue of user messages to deliver when viewing teammate transcript
  pendingUserMessages: string[]

  // UI: random spinner verbs (stable across re-renders, shared between components)
  spinnerVerb?: string
  pastTenseVerb?: string

  // 当前领取的 task assignment（用于 idle reconciliation）
  currentAssignment?: ClaimedTaskAssignment
  // Lifecycle
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

  // Callbacks to notify when teammate becomes idle (runtime only)
  // Used by leader to efficiently wait without polling
  onIdleCallbacks?: Array<() => void>

  // Progress tracking (for computing deltas in notifications)
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
 * Cap on the number of messages kept in task.messages (the AppState UI mirror).
 *
 * task.messages exists purely for the zoomed transcript dialog, which only
 * needs recent context. The full conversation lives in the local allMessages
 * array (inProcessRunner) and on disk at the agent transcript path.
 *
 * BQ analysis (round 9, 2026-03-20) showed ~20MB RSS per agent at 500+ turn
 * sessions and ~125MB per concurrent agent in swarm bursts. Whale session
 * 9a990de8 launched 292 agents in 2 minutes and reached 36.8GB. The dominant
 * cost is this array holding a second full copy of every message.
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
export const IDLE_COMPACT_MS = 10 * 60_000 // 10 min -> hibernate

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

/**
 * Stored tool result reference（工具结果外置时使用）
 */
/**
 * 结构化 task assignment（runner 在当前轮次中领取的任务）
 */
export type ClaimedTaskAssignment = {
  taskListId: string
  taskId: string
  owner: string
  claimToken: string
  claimedAt: number
  version: number
}

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
 * Append an item to a message array, capping the result at
 * TEAMMATE_MESSAGES_UI_CAP entries by dropping the oldest. Always returns
 * a new array (AppState immutability).
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
