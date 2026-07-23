/**
 * Teammate Mailbox - 基于文件的 agent 集群消息系统
 *
 * 每个 teammate 拥有一个收件箱文件，路径为 .zy/teams/{team_name}/inboxes/{agent_name}.json
 * 其他 teammate 可以向其中写入消息，接收方会以附件的形式看到这些消息。
 *
 * 注意：收件箱在团队内以 agent 名称作为键。
 *
 * 消息类型/构造器/检测器已拆分到 teammateMailboxMessages.ts。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TEAM_LEAD_NAME } from 'src/services/swarm/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import type { Message } from '../../types/message.js'
import { generateRequestId } from '../agent/agentId.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { getTeamsDir } from '../../services/infra/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import * as lockfile from '../file-persistence/lockfile.js'
import { logError } from '../../services/infra/log.js'
import { jsonParse, jsonStringify } from '../../services/infra/slowOperations.js'
import { sanitizePathComponent } from '../tasks-service/tasks.js'
import { getAgentName, getTeammateColor, getTeamName } from './teammate.js'
import { type TeammateMessage, createShutdownRequestMessage } from './teammateMailboxMessages.js'

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

// ============================================================================
// 类型和格式化 re-export（向后兼容 require() 用户）
// ============================================================================

/**
 * 校验 mailbox 条目形状，过滤畸形消息（对齐 CC 2.1.207 crash loop 修复）
 */
export function isValidTeammateMessage(value: unknown): value is TeammateMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  return (
    typeof m.from === 'string' &&
    typeof m.text === 'string' &&
    typeof m.timestamp === 'string' &&
    typeof m.read === 'boolean'
  )
}

/**
 * 将损坏的收件箱挪到旁路备份并重置为空数组，避免每秒 poll 重复 logError。
 */
async function quarantineCorruptMailbox(inboxPath: string, reason: string): Promise<void> {
  const backupPath = `${inboxPath}.corrupt.${Date.now()}`
  try {
    const raw = await readFile(inboxPath, 'utf-8')
    await writeFile(backupPath, raw, 'utf-8')
  } catch {
    // 备份失败仍尝试清空
  }
  try {
    await writeFile(inboxPath, '[]', 'utf-8')
    logForDebugging(
      `[TeammateMailbox] quarantined corrupt mailbox (${reason}): backup=${backupPath}`,
      { level: 'warn' },
    )
  } catch (error) {
    logForDebugging(`[TeammateMailbox] failed to reset corrupt mailbox: ${error}`, {
      level: 'error',
    })
  }
}

// ============================================================================
// 收件箱路径
// ============================================================================

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

// ============================================================================
// 读取
// ============================================================================

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
    let parsed: unknown
    try {
      parsed = jsonParse(content)
    } catch (parseError) {
      // 畸形 JSON：隔离并重置，防止 poll 每秒反复 logError（CC 2.1.207）
      logForDebugging(
        `[TeammateMailbox] readMailbox: invalid JSON for ${agentName}, quarantining: ${parseError}`,
        { level: 'warn' },
      )
      await quarantineCorruptMailbox(inboxPath, 'invalid-json')
      return []
    }

    if (!Array.isArray(parsed)) {
      logForDebugging(
        `[TeammateMailbox] readMailbox: expected array for ${agentName}, quarantining`,
        { level: 'warn' },
      )
      await quarantineCorruptMailbox(inboxPath, 'not-array')
      return []
    }

    const valid: TeammateMessage[] = []
    let dropped = 0
    for (const item of parsed) {
      if (isValidTeammateMessage(item)) {
        valid.push(item)
      } else {
        dropped++
      }
    }
    if (dropped > 0) {
      // 写回仅含合法条目的文件，避免畸形条目每秒被重新处理
      try {
        await writeFile(inboxPath, jsonStringify(valid, null, 2), 'utf-8')
        logForDebugging(
          `[TeammateMailbox] readMailbox: dropped ${dropped} malformed message(s) for ${agentName}`,
          { level: 'warn' },
        )
      } catch (writeError) {
        logForDebugging(
          `[TeammateMailbox] failed to rewrite mailbox after dropping malformed: ${writeError}`,
          { level: 'warn' },
        )
      }
    }

    logForDebugging(`[TeammateMailbox] readMailbox: read ${valid.length} message(s)`)
    return valid
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

// ============================================================================
// 写入
// ============================================================================

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

// ============================================================================
// 标记已读
// ============================================================================

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

// ============================================================================
// 发送关闭请求（同时使用消息构造器和 mailbox 操作）
// ============================================================================

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

// ============================================================================
// 基于谓词标记已读
// ============================================================================

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

// ============================================================================
// 工具函数
// ============================================================================

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
