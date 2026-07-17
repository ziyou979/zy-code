import { type ToolUseContext, type ToolPermissionContext } from '../../../tools/tool.js'
import { getViewedTeammateTask } from '../../../state/selectors.js'
import type { Message } from 'src/types/message.js'
import { getContextWindowForModel } from '../../context/modelContext.js'
import { matchingRuleForInput } from '../../permissions/filesystem.js'
import {
  getTotalCost,
  getTotalOutputTokens,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../../../bootstrap/runtime/runtimeContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { isEnvTruthy, getZyConfigHomeDir } from '../../utils/envUtils.js'
import { feature } from 'bun:bundle'
import { tokenCountFromLastAPIResponse, tokenCountWithEstimation } from '../../utils/tokens.js'
import { getEffectiveContextWindowSize, isAutoCompactEnabled } from '../../compact/autoCompact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import { isAgentSwarmsEnabled } from '../../swarm/agentSwarmsEnabled.js'
import {
  readUnreadMessages,
  markMessagesAsReadByPredicate,
  isShutdownApproved,
  isStructuredProtocolMessage,
  isIdleNotification,
} from '../../utils/teammateMailbox.js'
import { getAgentName, getAgentId, getTeamName, isTeamLead } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { removeTeammateFromTeamFile } from 'src/services/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../../tasks-service/tasks.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { Attachment, VERIFY_PLAN_REMINDER_CONFIG } from './types.js'
/**
 * Get teammate mailbox attachments for agent swarm communication
 * Teammates are independent ZY Code sessions running in parallel (swarms),
 * not parent-child subagent relationships.
 *
 * This function checks two sources for messages:
 * 1. File-based mailbox (for messages that arrived between polls)
 * 2. AppState.inbox (for messages queued mid-turn by useInboxPoller)
 *
 * Messages from AppState.inbox are delivered mid-turn as attachments,
 * allowing teammates to receive messages without waiting for the turn to end.
 */
export async function getTeammateMailboxAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return []
  }
  if (!isInternalBuild()) {
    return []
  }

  // 提前获取 AppState 以检查 team lead 状态
  const appState = toolUseContext.getAppState()

  // 使用助手中的 agent 名称（先检查 AsyncLocalStorage，然后 dynamicTeamContext）
  const envAgentName = getAgentName()

  // 获取团队名称（检查 AsyncLocalStorage、dynamicTeamContext，然后 AppState）
  const teamName = getTeamName(appState.teamContext)

  // 检查我们是否是 team lead（使用 swarm utils 的共享逻辑）
  const teamLeadStatus = isTeamLead(appState.teamContext)

  // 检查是否正在查看 teammate 的 transcript（用于进程内 teammate）
  const viewedTeammate = getViewedTeammateTask(appState)

  // 根据我们正在 VIEWING 的对象解析 agent 名称：
  // - 如果正在查看 teammate，使用他们的名称（从他们的邮箱读取）
  // - 否则使用环境变量（如果设置），或者如果我们是 team lead 则使用 leader 的名称
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext.leadAgentId
    // 从 agents 映射查找 lead 的名称（而非 UUID）
    agentName = appState.teamContext.teammates[leadAgentId]?.name || 'team-lead'
  }
  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  // 仅当作为 swarm 中的 agent 或 team lead 运行时才检查收件箱
  if (!agentName) {
    logForDebugging(`[SwarmMailbox] Not checking inbox - not in a swarm or team lead`)
    return []
  }
  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  // 检查邮箱中的未读消息（路由到进程内或基于文件）
  // 过滤掉结构化协议消息（权限请求/响应、关闭消息等）—
  // 这些必须保持未读，以便 useInboxPoller 路由到正确的处理器
  //（workerPermissions 队列、sandbox 队列等）。如果不过滤，
  // 附件生成会与 InboxPoller 竞争：先读取的一方会将所有消息标记为已读，
  // 如果附件获胜，协议消息会被打包为原始 LLM 上下文文本，而非路由到其 UI 处理器。
  const allUnreadMessages = await readUnreadMessages(agentName, teamName)
  const unreadMessages = allUnreadMessages.filter((m) => !isStructuredProtocolMessage(m.text))
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  // 同时检查 AppState.inbox 中的待处理消息（由 useInboxPoller 在轮次中途排队）
  // 重要：appState.inbox 包含从 teammate 发送到 leader 的消息。
  // 仅在查看 leader 的 transcript 时显示这些消息（而非 teammate 的）。
  // 查看 teammate 时，他们的消息来自上方的基于文件的邮箱。
  // 进程内 teammate 与 leader 共享 AppState — appState.inbox 包含
  // LEADER 的排队消息，而非 teammate 的。跳过它以防止泄漏
  //（包括来自广播的自回显）。teammate 仅通过其基于文件的邮箱 +
  // waitForNextPromptOrShutdown 接收消息。
  // 注意：viewedTeammate 已在上方为 agentName 解析计算过
  const pendingInboxMessages =
    viewedTeammate || isInProcessTeammate()
      ? [] // 正在查看 teammate 或作为进程内 teammate 运行 — 不显示 leader 的收件箱
      : appState.inbox.messages.filter((m) => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  // 合并两个消息源并进行去重
  // 同一条消息可能同时存在于文件邮箱和 AppState.inbox 中（由于竞争条件）：
  // 1. getTeammateMailboxAttachments 读取文件 -> 找到消息 M
  // 2. InboxPoller 读取相同文件 -> 将 M 排队到 AppState.inbox
  // 3. getTeammateMailboxAttachments 读取 AppState -> 再次找到 M
  // 我们使用 from+timestamp+text 前缀作为 key 进行去重
  const seen = new Set<string>()
  let allMessages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }> = []
  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) {
      seen.add(key)
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary,
      })
    }
  }

  // 合并每个 agent 的多个空闲通知 — 仅保留最新的。
  // 单次解析，然后过滤而无需重新解析。
  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text)
    if (idle) {
      idleAgentByIndex.set(i, idle.from)
      latestIdleByAgent.set(idle.from, i)
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) {
        return true
      }
      return latestIdleByAgent.get(agent) === i
    })
    logForDebugging(
      `[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`,
    )
  }
  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`)
    return []
  }
  logForDebugging(
    `[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`,
  )

  // 在将消息标记为已处理之前构建附件
  // 这可以防止如果下方任何操作失败时的消息丢失
  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  // 附件构建后仅将非结构化邮箱消息标记为已读。
  // 结构化协议消息保持未读以供 useInboxPoller 处理。
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(
      agentName,
      (m) => !isStructuredProtocolMessage(m.text),
      teamName,
    )
    logForDebugging(
      `[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`,
    )
  }

  // 处理 shutdown_approved 消息 — 从团队文件中移除 teammate
  // 这镜像了 useInboxPoller 在交互模式中的行为（第 546-606 行）
  // 在 -p 模式下，useInboxPoller 不运行，因此我们必须在此处处理
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const teammateToRemove = shutdownApproval.from
        logForDebugging(`[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`)

        // 按名称查找 teammate ID
        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined
        if (teammateId) {
          // 从团队文件中移除
          removeTeammateFromTeamFile(teamName, {
            agentId: teammateId,
            name: teammateToRemove,
          })
          logForDebugging(`[SwarmMailbox] Removed ${teammateToRemove} from team file`)

          // 取消分配此 teammate 拥有的任务
          await unassignTeammateTasks(teamName, teammateId, teammateToRemove, 'shutdown')

          // 从 AppState 的 teamContext 中移除
          toolUseContext.setAppState((prev) => {
            if (!prev.teamContext?.teammates) {
              return prev
            }
            if (!(teammateId in prev.teamContext.teammates)) {
              return prev
            }
            const { [teammateId]: _, ...remainingTeammates } = prev.teamContext.teammates
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates,
              },
            }
          })
        }
      }
    }
  }

  // 最后在附件构建后将 AppState 收件箱消息标记为已处理
  // 这确保如果 earlier 操作失败时消息不会丢失
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map((m) => m.id))
    toolUseContext.setAppState((prev) => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map((m) =>
          pendingIds.has(m.id)
            ? {
                ...m,
                status: 'processed' as const,
              }
            : m,
        ),
      },
    }))
  }
  return attachment
}

/**
 * Get team context attachment for teammates in a swarm.
 * Only injected on the first turn to provide team coordination instructions.
 */
export function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // 仅为 teammate 注入（非 team lead 或非团队会话）
  if (!teamName || !agentId) {
    return []
  }

  // 仅在首轮注入 — 检查是否尚无 assistant 消息
  const hasAssistantMessage = messages.some((m) => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }
  const configDir = getZyConfigHomeDir()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`
  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}

export function getTokenUsageAttachment(messages: Message[], model: string): Attachment[] {
  if (!isEnvTruthy(process.env.ZY_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }
  const contextWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountFromLastAPIResponse(messages)
  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

export function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

export function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }
  const usedCost = getTotalCost()
  const remainingBudget = maxBudgetUsd - usedCost
  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}

/**
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // 在 plan_mode_exit 附件处停止计数（标记实现开始时间）
    if (message?.type === 'attachment' && message.attachment.type === 'plan_mode_exit') {
      return turnCount
    }
  }
  // 未找到 plan_mode_exit
  return 0
}

/**
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
export async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isInternalBuild() || !isEnvTruthy(process.env.ZY_CODE_VERIFY_PLAN)) {
    return []
  }
  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // 仅在计划存在且验证未开始或完成时才提醒
  if (!pending || pending.verificationStarted || pending.verificationCompleted) {
    return []
  }

  // 仅每 N 轮提醒一次
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (turnCount === 0 || turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0) {
      return []
    }
  }
  return [
    {
      type: 'verify_plan_reminder',
    },
  ]
}

export function getCompactionReminderAttachment(messages: Message[], model: string): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_marble_fox', false)) {
    return []
  }
  if (!isAutoCompactEnabled()) {
    return []
  }
  const contextWindow = getContextWindowForModel(model)
  if (contextWindow < 1_000_000) {
    return []
  }
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }
  return [
    {
      type: 'compaction_reminder',
    },
  ]
}

export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(filePath, toolPermissionContext, 'read', 'deny')
  return denyRule !== null
}
