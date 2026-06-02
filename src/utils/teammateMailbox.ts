/**
 * Teammate Mailbox - 基于文件的 agent 集群消息系统
 *
 * 每个 teammate 拥有一个收件箱文件，路径为 .zy/teams/{team_name}/inboxes/{agent_name}.json
 * 其他 teammate 可以向其中写入消息，接收方会以附件的形式看到这些消息。
 *
 * 注意：收件箱在团队内以 agent 名称作为键。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackendType } from 'src/services/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from 'src/services/swarm/constants.js'
import { z } from 'zod/v4'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { PermissionModeSchema } from '../types/coreSchemas.js'
import type { Message } from '../types/message.js'
import { generateRequestId } from './agentId.js'
import { count } from './array.js'
import { logForDebugging } from './debug.js'
import { getTeamsDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { lazySchema } from './lazySchema.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { sanitizePathComponent } from './tasks.js'
import { getAgentName, getTeammateColor, getTeamName } from './teammate.js'

// 锁选项：使用退避重试策略，使并发调用者（集群中的多个 Zy 实例）
// 等待锁释放而非立即失败。同步的 lockSync API 会阻塞事件循环；
// 异步 API 需要显式重试来实现相同的序列化语义。
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

export type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string // 发送方分配的颜色（例如 'red'、'blue'、'green'）
  summary?: string // 5-10 个词的摘要，在 UI 中作为预览显示
}

/**
 * 获取 teammate 收件箱文件的路径
 * 结构：~/.zy/teams/{team_name}/inboxes/{agent_name}.json
 */
export function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const safeAgentName = sanitizePathComponent(agentName)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  const fullPath = join(inboxDir, `${safeAgentName}.json`)
  logForDebugging(
    `[TeammateMailbox] getInboxPath: agent=${agentName}, team=${team}, fullPath=${fullPath}`,
  )
  return fullPath
}

/**
 * 确保团队的收件箱目录存在
 */
async function ensureInboxDir(teamName?: string): Promise<void> {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  await mkdir(inboxDir, { recursive: true })
  logForDebugging(`[TeammateMailbox] Ensured inbox directory: ${inboxDir}`)
}

/**
 * 读取 teammate 收件箱中的所有消息
 * @param agentName - 要读取收件箱的 agent 名称（非 UUID）
 * @param teamName - 可选的团队名称（默认使用 ZY_CODE_TEAM_NAME 环境变量或 'default'）
 */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(`[TeammateMailbox] readMailbox: path=${inboxPath}`)

  try {
    const content = await readFile(inboxPath, 'utf-8')
    const messages = jsonParse(content) as TeammateMessage[]
    logForDebugging(`[TeammateMailbox] readMailbox: read ${messages.length} message(s)`)
    return messages
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(`[TeammateMailbox] readMailbox: file does not exist`)
      return []
    }
    logForDebugging(`Failed to read inbox for ${agentName}: ${error}`)
    logError(error)
    return []
  }
}

/**
 * 仅读取 teammate 收件箱中的未读消息
 * @param agentName - 要读取收件箱的 agent 名称（非 UUID）
 * @param teamName - 可选的团队名称
 */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const messages = await readMailbox(agentName, teamName)
  const unread = messages.filter((m) => !m.read)
  logForDebugging(
    `[TeammateMailbox] readUnreadMessages: ${unread.length} unread of ${messages.length} total`,
  )
  return unread
}

/**
 * 向 teammate 的收件箱写入一条消息
 * 使用文件锁防止多个 agent 并发写入时产生竞态条件
 * @param recipientName - 接收方的 agent 名称（非 UUID）
 * @param message - 要写入的消息
 * @param teamName - 可选的团队名称
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await ensureInboxDir(teamName)

  const inboxPath = getInboxPath(recipientName, teamName)
  const lockFilePath = `${inboxPath}.lock`

  logForDebugging(
    `[TeammateMailbox] writeToMailbox: recipient=${recipientName}, from=${message.from}, path=${inboxPath}`,
  )

  // 在加锁之前确保收件箱文件存在（proper-lockfile 要求文件必须存在）
  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(`[TeammateMailbox] writeToMailbox: created new inbox file`)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'EEXIST') {
      logForDebugging(`[TeammateMailbox] writeToMailbox: failed to create inbox file: ${error}`)
      logError(error)
      return
    }
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })

    // 获取锁之后重新读取消息以获得最新状态
    const messages = await readMailbox(recipientName, teamName)

    const newMessage: TeammateMessage = {
      ...message,
      read: false,
    }

    messages.push(newMessage)

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] Wrote message to ${recipientName}'s inbox from ${message.from}`,
    )
  } catch (error) {
    logForDebugging(`Failed to write to inbox for ${recipientName}: ${error}`)
    logError(error)
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * 按索引将 teammate 收件箱中的指定消息标记为已读
 * 使用文件锁防止竞态条件
 * @param agentName - 要标记消息已读的 agent 名称
 * @param teamName - 可选的团队名称
 * @param messageIndex - 要标记为已读的消息索引
 */
export async function markMessageAsReadByIndex(
  agentName: string,
  teamName: string | undefined,
  messageIndex: number,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(
    `[TeammateMailbox] markMessageAsReadByIndex called: agentName=${agentName}, teamName=${teamName}, index=${messageIndex}, path=${inboxPath}`,
  )

  const lockFilePath = `${inboxPath}.lock`

  let release: (() => Promise<void>) | undefined
  try {
    logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex: acquiring lock...`)
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex: lock acquired`)

    // 获取锁之后重新读取消息以获得最新状态
    const messages = await readMailbox(agentName, teamName)
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex: read ${messages.length} messages after lock`,
    )

    if (messageIndex < 0 || messageIndex >= messages.length) {
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: index ${messageIndex} out of bounds (${messages.length} messages)`,
      )
      return
    }

    const message = messages[messageIndex]
    if (!message || message.read) {
      logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex: message already read or missing`)
      return
    }

    messages[messageIndex] = { ...message, read: true }

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex: marked message at index ${messageIndex} as read`,
    )
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: file does not exist at ${inboxPath}`,
      )
      return
    }
    logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex FAILED for ${agentName}: ${error}`)
    logError(error)
  } finally {
    if (release) {
      await release()
      logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex: lock released`)
    }
  }
}

/**
 * 将 teammate 收件箱中的所有消息标记为已读
 * 使用文件锁防止竞态条件
 * @param agentName - 要标记消息已读的 agent 名称
 * @param teamName - 可选的团队名称
 */
export async function markMessagesAsRead(agentName: string, teamName?: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(
    `[TeammateMailbox] markMessagesAsRead called: agentName=${agentName}, teamName=${teamName}, path=${inboxPath}`,
  )

  const lockFilePath = `${inboxPath}.lock`

  let release: (() => Promise<void>) | undefined
  try {
    logForDebugging(`[TeammateMailbox] markMessagesAsRead: acquiring lock...`)
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    logForDebugging(`[TeammateMailbox] markMessagesAsRead: lock acquired`)

    // 获取锁之后重新读取消息以获得最新状态
    const messages = await readMailbox(agentName, teamName)
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: read ${messages.length} messages after lock`,
    )

    if (messages.length === 0) {
      logForDebugging(`[TeammateMailbox] markMessagesAsRead: no messages to mark`)
      return
    }

    const unreadCount = count(messages, (m) => !m.read)
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: ${unreadCount} unread of ${messages.length} total`,
    )

    // messages 来自 jsonParse —— 全新的、未共享的对象，可以安全地直接修改
    for (const m of messages) {
      m.read = true
    }

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: WROTE ${unreadCount} message(s) as read to ${inboxPath}`,
    )
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(`[TeammateMailbox] markMessagesAsRead: file does not exist at ${inboxPath}`)
      return
    }
    logForDebugging(`[TeammateMailbox] markMessagesAsRead FAILED for ${agentName}: ${error}`)
    logError(error)
  } finally {
    if (release) {
      await release()
      logForDebugging(`[TeammateMailbox] markMessagesAsRead: lock released`)
    }
  }
}

/**
 * 清空 teammate 的收件箱（删除所有消息）
 * @param agentName - 要清空收件箱的 agent 名称
 * @param teamName - 可选的团队名称
 */
export async function clearMailbox(agentName: string, teamName?: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)

  try {
    // 标志 'r+' 在文件不存在时会抛出 ENOENT，因此不会
    // 意外创建一个原本不存在的收件箱文件。
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'r+' })
    logForDebugging(`[TeammateMailbox] Cleared inbox for ${agentName}`)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return
    }
    logForDebugging(`Failed to clear inbox for ${agentName}: ${error}`)
    logError(error)
  }
}

/**
 * 将 teammate 消息格式化为 XML 以供附件展示
 */
export function formatTeammateMessages(
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>,
): string {
  return messages
    .map((m) => {
      const colorAttr = m.color ? ` color="${m.color}"` : ''
      const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
      return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
    })
    .join('\n\n')
}

/**
 * teammate 进入空闲状态时发送的结构化消息（通过 Stop hook 触发）
 */
export type IdleNotificationMessage = {
  type: 'idle_notification'
  from: string
  timestamp: string
  /** agent 进入空闲状态的原因 */
  idleReason?: 'available' | 'interrupted' | 'failed'
  /** 本轮最后一条私信的简要摘要（如果有的话） */
  summary?: string
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
}

/**
 * 创建一条空闲通知消息，发送给团队领导
 */
export function createIdleNotification(
  agentId: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason']
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
  },
): IdleNotificationMessage {
  return {
    type: 'idle_notification',
    from: agentId,
    timestamp: new Date().toISOString(),
    idleReason: options?.idleReason,
    summary: options?.summary,
    completedTaskId: options?.completedTaskId,
    completedStatus: options?.completedStatus,
    failureReason: options?.failureReason,
  }
}

/**
 * 检查消息文本中是否包含空闲通知
 */
export function isIdleNotification(messageText: string): IdleNotificationMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'idle_notification') {
      return parsed as IdleNotificationMessage
    }
  } catch {
    // 非 JSON 或非有效的空闲通知
  }
  return null
}

/**
 * 从 worker 通过 mailbox 发送给 leader 的权限请求消息。
 * 字段名与 SDK `can_use_tool` 保持一致（snake_case）。
 */
export type PermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  agent_id: string
  tool_name: string
  toolCallId: string
  description: string
  input: Record<string, unknown>
  permission_suggestions: unknown[]
}

/**
 * 从 leader 通过 mailbox 发送给 worker 的权限响应消息。
 * 结构与 SDK ControlResponseSchema / ControlErrorResponseSchema 对齐。
 */
export type PermissionResponseMessage =
  | {
      type: 'permission_response'
      request_id: string
      subtype: 'success'
      response?: {
        updated_input?: Record<string, unknown>
        permission_updates?: unknown[]
      }
    }
  | {
      type: 'permission_response'
      request_id: string
      subtype: 'error'
      error: string
    }

/**
 * 创建一条权限请求消息，发送给团队领导
 */
export function createPermissionRequestMessage(params: {
  request_id: string
  agent_id: string
  tool_name: string
  toolCallId: string
  description: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
}): PermissionRequestMessage {
  return {
    type: 'permission_request',
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    toolCallId: params.toolCallId,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  }
}

/**
 * 创建一条权限响应消息，发送回 worker
 */
export function createPermissionResponseMessage(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
  permission_updates?: unknown[]
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    }
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'success',
    response: {
      updated_input: params.updated_input,
      permission_updates: params.permission_updates,
    },
  }
}

/**
 * 检查消息文本中是否包含权限请求
 */
export function isPermissionRequest(messageText: string): PermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'permission_request') {
      return parsed as PermissionRequestMessage
    }
  } catch {
    // 非 JSON 或非有效的权限请求
  }
  return null
}

/**
 * 检查消息文本中是否包含权限响应
 */
export function isPermissionResponse(messageText: string): PermissionResponseMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'permission_response') {
      return parsed as PermissionResponseMessage
    }
  } catch {
    // 非 JSON 或非有效的权限响应
  }
  return null
}

/**
 * 从 worker 通过 mailbox 发送给 leader 的沙箱权限请求消息。
 * 当沙箱运行时检测到对未允许主机的网络访问时触发。
 */
export type SandboxPermissionRequestMessage = {
  type: 'sandbox_permission_request'
  /** 此请求的唯一标识符 */
  requestId: string
  /** Worker 的 ZY_CODE_AGENT_ID */
  workerId: string
  /** Worker 的 ZY_CODE_AGENT_NAME */
  workerName: string
  /** Worker 的 ZY_CODE_AGENT_COLOR */
  workerColor?: string
  /** 请求网络访问的主机模式 */
  hostPattern: {
    host: string
  }
  /** 请求创建时的时间戳 */
  createdAt: number
}

/**
 * 从 leader 通过 mailbox 发送给 worker 的沙箱权限响应消息
 */
export type SandboxPermissionResponseMessage = {
  type: 'sandbox_permission_response'
  /** 此响应对应的请求 ID */
  requestId: string
  /** 被批准/拒绝的主机 */
  host: string
  /** 是否允许该连接 */
  allow: boolean
  /** 响应创建时的时间戳 */
  timestamp: string
}

/**
 * 创建一条沙箱权限请求消息，发送给团队领导
 */
export function createSandboxPermissionRequestMessage(params: {
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  host: string
}): SandboxPermissionRequestMessage {
  return {
    type: 'sandbox_permission_request',
    requestId: params.requestId,
    workerId: params.workerId,
    workerName: params.workerName,
    workerColor: params.workerColor,
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  }
}

/**
 * 创建一条沙箱权限响应消息，发送回 worker
 */
export function createSandboxPermissionResponseMessage(params: {
  requestId: string
  host: string
  allow: boolean
}): SandboxPermissionResponseMessage {
  return {
    type: 'sandbox_permission_response',
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 检查消息文本中是否包含沙箱权限请求
 */
export function isSandboxPermissionRequest(
  messageText: string,
): SandboxPermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'sandbox_permission_request') {
      return parsed as SandboxPermissionRequestMessage
    }
  } catch {
    // 非 JSON 或非有效的沙箱权限请求
  }
  return null
}

/**
 * 检查消息文本中是否包含沙箱权限响应
 */
export function isSandboxPermissionResponse(
  messageText: string,
): SandboxPermissionResponseMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'sandbox_permission_response') {
      return parsed as SandboxPermissionResponseMessage
    }
  } catch {
    // 非 JSON 或非有效的沙箱权限响应
  }
  return null
}

/**
 * teammate 向团队领导请求计划审批时发送的消息
 */
export const PlanApprovalRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_request'),
    from: z.string(),
    timestamp: z.string(),
    planFilePath: z.string(),
    planContent: z.string(),
    requestId: z.string(),
  }),
)

export type PlanApprovalRequestMessage = z.infer<
  ReturnType<typeof PlanApprovalRequestMessageSchema>
>

/**
 * 团队领导对计划审批请求的响应消息
 */
export const PlanApprovalResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_response'),
    requestId: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
    timestamp: z.string(),
    permissionMode: PermissionModeSchema().optional(),
  }),
)

export type PlanApprovalResponseMessage = z.infer<
  ReturnType<typeof PlanApprovalResponseMessageSchema>
>

/**
 * 从 leader 通过 mailbox 发送给 teammate 的关闭请求消息
 */
export const ShutdownRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_request'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string().optional(),
    timestamp: z.string(),
  }),
)

export type ShutdownRequestMessage = z.infer<ReturnType<typeof ShutdownRequestMessageSchema>>

/**
 * 从 teammate 通过 mailbox 发送给 leader 的关闭批准消息
 */
export const ShutdownApprovedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_approved'),
    requestId: z.string(),
    from: z.string(),
    timestamp: z.string(),
    paneId: z.string().optional(),
    backendType: z.string().optional(),
  }),
)

export type ShutdownApprovedMessage = z.infer<ReturnType<typeof ShutdownApprovedMessageSchema>>

/**
 * 从 teammate 通过 mailbox 发送给 leader 的关闭拒绝消息
 */
export const ShutdownRejectedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_rejected'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string(),
    timestamp: z.string(),
  }),
)

export type ShutdownRejectedMessage = z.infer<ReturnType<typeof ShutdownRejectedMessageSchema>>

/**
 * 创建一条关闭请求消息，发送给 teammate
 */
export function createShutdownRequestMessage(params: {
  requestId: string
  from: string
  reason?: string
}): ShutdownRequestMessage {
  return {
    type: 'shutdown_request',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 创建一条关闭批准消息，发送给团队领导
 */
export function createShutdownApprovedMessage(params: {
  requestId: string
  from: string
  paneId?: string
  backendType?: BackendType
}): ShutdownApprovedMessage {
  return {
    type: 'shutdown_approved',
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
    paneId: params.paneId,
    backendType: params.backendType,
  }
}

/**
 * 创建一条关闭拒绝消息，发送给团队领导
 */
export function createShutdownRejectedMessage(params: {
  requestId: string
  from: string
  reason: string
}): ShutdownRejectedMessage {
  return {
    type: 'shutdown_rejected',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 向 teammate 的 mailbox 发送关闭请求。
 * 这是提取出的核心逻辑，供工具和 UI 组件复用。
 *
 * @param targetName - 要发送关闭请求的 teammate 名称
 * @param teamName - 可选的团队名称（默认使用 ZY_CODE_TEAM_NAME 环境变量）
 * @param reason - 可选的关闭请求原因
 * @returns 请求 ID 和目标名称
 */
export async function sendShutdownRequestToMailbox(
  targetName: string,
  teamName?: string,
  reason?: string,
): Promise<{ requestId: string; target: string }> {
  const resolvedTeamName = teamName || getTeamName()

  // 获取发送方名称（支持通过 AsyncLocalStorage 的进程内 teammate）
  const senderName = getAgentName() || TEAM_LEAD_NAME

  // 为此关闭请求生成确定性的请求 ID
  const requestId = generateRequestId('shutdown', targetName)

  // 创建并发送关闭请求消息
  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    resolvedTeamName,
  )

  return { requestId, target: targetName }
}

/**
 * 检查消息文本中是否包含关闭请求
 */
export function isShutdownRequest(messageText: string): ShutdownRequestMessage | null {
  try {
    const result = ShutdownRequestMessageSchema().safeParse(jsonParse(messageText))
    if (result.success) {
      return result.data
    }
  } catch {
    // 非 JSON
  }
  return null
}

/**
 * 检查消息文本中是否包含计划审批请求
 */
export function isPlanApprovalRequest(messageText: string): PlanApprovalRequestMessage | null {
  try {
    const result = PlanApprovalRequestMessageSchema().safeParse(jsonParse(messageText))
    if (result.success) {
      return result.data
    }
  } catch {
    // 非 JSON
  }
  return null
}

/**
 * 检查消息文本中是否包含关闭批准消息
 */
export function isShutdownApproved(messageText: string): ShutdownApprovedMessage | null {
  try {
    const result = ShutdownApprovedMessageSchema().safeParse(jsonParse(messageText))
    if (result.success) {
      return result.data
    }
  } catch {
    // 非 JSON
  }
  return null
}

/**
 * 检查消息文本中是否包含关闭拒绝消息
 */
export function isShutdownRejected(messageText: string): ShutdownRejectedMessage | null {
  try {
    const result = ShutdownRejectedMessageSchema().safeParse(jsonParse(messageText))
    if (result.success) {
      return result.data
    }
  } catch {
    // 非 JSON
  }
  return null
}

/**
 * 检查消息文本中是否包含计划审批响应
 */
export function isPlanApprovalResponse(messageText: string): PlanApprovalResponseMessage | null {
  try {
    const result = PlanApprovalResponseMessageSchema().safeParse(jsonParse(messageText))
    if (result.success) {
      return result.data
    }
  } catch {
    // 非 JSON
  }
  return null
}

/**
 * 任务分配给 teammate 时发送的任务分配消息
 */
export type TaskAssignmentMessage = {
  type: 'task_assignment'
  taskId: string
  subject: string
  description: string
  assignedBy: string
  timestamp: string
}

/**
 * 检查消息文本中是否包含任务分配
 */
export function isTaskAssignment(messageText: string): TaskAssignmentMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'task_assignment') {
      return parsed as TaskAssignmentMessage
    }
  } catch {
    // 非 JSON 或非有效的任务分配
  }
  return null
}

/**
 * 从 leader 通过 mailbox 发送给 teammate 的团队权限更新消息。
 * 广播适用于所有 teammate 的权限更新。
 */
export type TeamPermissionUpdateMessage = {
  type: 'team_permission_update'
  /** 要应用的权限更新 */
  permissionUpdate: {
    type: 'addRules'
    rules: Array<{ toolName: string; ruleContent?: string }>
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'session'
  }
  /** 被允许的目录路径 */
  directoryPath: string
  /** 此规则适用的工具名称 */
  toolName: string
}

/**
 * 检查消息文本中是否包含团队权限更新
 */
export function isTeamPermissionUpdate(messageText: string): TeamPermissionUpdateMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'team_permission_update') {
      return parsed as TeamPermissionUpdateMessage
    }
  } catch {
    // 非 JSON 或非有效的团队权限更新
  }
  return null
}

/**
 * 从 leader 通过 mailbox 发送给 teammate 的模式设置请求消息。
 * 使用 SDK PermissionModeSchema 进行模式值校验。
 */
export const ModeSetRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('mode_set_request'),
    mode: PermissionModeSchema(),
    from: z.string(),
  }),
)

export type ModeSetRequestMessage = z.infer<ReturnType<typeof ModeSetRequestMessageSchema>>

/**
 * 创建一条模式设置请求消息，发送给 teammate
 */
export function createModeSetRequestMessage(params: {
  mode: string
  from: string
}): ModeSetRequestMessage {
  return {
    type: 'mode_set_request',
    mode: params.mode as ModeSetRequestMessage['mode'],
    from: params.from,
  }
}

/**
 * 检查消息文本中是否包含模式设置请求
 */
export function isModeSetRequest(messageText: string): ModeSetRequestMessage | null {
  try {
    const parsed = ModeSetRequestMessageSchema().safeParse(jsonParse(messageText))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // 非 JSON 或非有效的模式设置请求
  }
  return null
}

/**
 * 检查消息文本是否为结构化协议消息，这类消息应由 useInboxPoller
 * 路由处理，而非作为原始 LLM 上下文消费。
 *
 * 这些消息类型在 useInboxPoller 中有专门的处理器，会将它们路由到
 * 正确的队列（workerPermissions、workerSandboxPermissions 等）。
 * 如果 getTeammateMailboxAttachments 先消费了它们，就会被打包为
 * 附件中的原始文本，永远无法到达其预期的处理器。
 */
export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = jsonParse(messageText)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return false
    }
    const type = (parsed as { type: unknown }).type
    return (
      type === 'permission_request' ||
      type === 'permission_response' ||
      type === 'sandbox_permission_request' ||
      type === 'sandbox_permission_response' ||
      type === 'shutdown_request' ||
      type === 'shutdown_approved' ||
      type === 'team_permission_update' ||
      type === 'mode_set_request' ||
      type === 'plan_approval_request' ||
      type === 'plan_approval_response'
    )
  } catch {
    return false
  }
}

/**
 * 仅将匹配谓词条件的消息标记为已读，其余消息保持未读。
 * 使用与 markMessagesAsRead 相同的文件锁机制。
 */
export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (msg: TeammateMessage) => boolean,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)

  const lockFilePath = `${inboxPath}.lock`
  let release: (() => Promise<void>) | undefined

  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })

    const messages = await readMailbox(agentName, teamName)
    if (messages.length === 0) {
      return
    }

    const updatedMessages = messages.map((m) =>
      !m.read && predicate(m) ? { ...m, read: true } : m,
    )

    await writeFile(inboxPath, jsonStringify(updatedMessages, null, 2), 'utf-8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return
    }
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // 锁可能已经被释放
      }
    }
  }
}

/**
 * 从最后一条 assistant 消息中提取 "[to {name}] {summary}" 字符串，
 * 前提是该消息以一个发送给同级（非团队领导）的 SendMessage tool_use 结尾。
 * 当本轮未以同级私信结尾时返回 undefined。
 */
export function getLastPeerDmSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) {
      continue
    }

    // 在唤醒边界处停止：用户提示（string 类型内容），而非工具结果（array 类型内容）
    if (msg.type === 'user' && typeof msg.message.content === 'string') {
      break
    }

    if (msg.type !== 'assistant') {
      continue
    }
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_call' &&
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to !== '*' &&
        block.input.to.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase() &&
        'message' in block.input &&
        typeof block.input.message === 'string'
      ) {
        const to = block.input.to
        const summary =
          'summary' in block.input && typeof block.input.summary === 'string'
            ? block.input.summary
            : block.input.message.slice(0, 80)
        return `[to ${to}] ${summary}`
      }
    }
  }
  return undefined
}
