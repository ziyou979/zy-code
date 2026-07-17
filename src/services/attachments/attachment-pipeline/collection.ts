// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { type ToolUseContext } from '../../../tools/tool.js'
import type { IDESelection } from '../../../hooks/useIdeSelection.js'
import { isTodoV2Enabled } from '../../utils/tasks.js'
import { getPlanFilePath, getPlan } from '../../../services/plans/plans.js'
import { logError } from '../../utils/log.js'
import { logAntError } from '../../utils/debug.js'
import type { Message } from 'src/types/message.js'
import {
  type QueuedCommand,
  getImagePasteIds,
  isValidImagePaste,
} from 'src/types/textInputTypes.js'
import type { ContentBlock, ImageBlock, ImageSource } from '../../../types/llm.js'
import { maybeResizeAndDownsampleImageBlock } from '../../utils/imageResizer.js'
import type { PastedContent } from '../../config/config.js'
import { createAbortController } from '../../utils/abortController.js'
import { drainPendingMessages } from '../../../tasks/local-agent-task/LocalAgentTask.js'
import {
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  needsPlanModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  needsAutoModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  getLastEmittedDate,
  setLastEmittedDate,
  getKairosActive,
} from '../../../bootstrap/runtime/runtimeContext.js'
import type { QuerySource } from '../../../constants/querySource.js'
import { extractTextContent } from '../../messages/predicates.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { feature } from 'bun:bundle'
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasUltrathinkKeyword, isUltrathinkEnabled } from '../../utils/thinking.js'
import { hasWorkflowKeyword } from '../../workflow/keyword.js'
import { isOrchestrateEffort } from '../../../services/effort/effort.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getLocalISODate } from '../../../constants/common.js'
import { isAgentSwarmsEnabled } from '../../swarm/agentSwarmsEnabled.js'
import {
  AUTO_MODE_ATTACHMENT_CONFIG,
  Attachment,
  PLAN_MODE_ATTACHMENT_CONFIG,
  autoModeStateModule,
  sessionTranscriptModule,
  skillSearchModules,
} from './types.js'
import {
  getAgentListingDeltaAttachment,
  getChangedFiles,
  getCriticalSystemReminderAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
  getOpenedFileFromIDE,
  getOutputStyleAttachment,
  getSelectedLinesFromIDE,
  processAgentMentions,
  processAtMentionedFiles,
  processMcpResourceAttachments,
} from './modeReminders.js'
import {
  getDiagnosticAttachments,
  getDynamicSkillAttachments,
  getNestedMemoryAttachments,
  getSkillListingAttachments,
  hasToolResultContent,
} from './contextDelta.js'
import {
  getAsyncHookResponseAttachments,
  getLSPDiagnosticAttachments,
  getTaskReminderAttachments,
  getTodoReminderAttachments,
  getUnifiedTaskAttachments,
} from './memory.js'
import {
  getCompactionReminderAttachment,
  getMaxBudgetUsdAttachment,
  getOutputTokenUsageAttachment,
  getTeamContextAttachment,
  getTeammateMailboxAttachments,
  getTokenUsageAttachment,
  getVerifyPlanReminderAttachment,
} from './skills.js'
/**
 * 这段代码有些粗糙
 * TODO: 在创建消息时生成附件，而不是这里
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: {
    skipSkillDiscovery?: boolean
  },
): Promise<Attachment[]> {
  if (
    isEnvTruthy(process.env.ZY_CODE_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.ZY_CODE_SIMPLE)
  ) {
    // query.ts:removeFromQueue 在 getAttachmentMessages 运行后无条件地将这些出队 —
    // 在此返回 [] 会静默丢弃它们。
    // Coworker 以 --bare 运行，依赖 task-notification 获取
    // Local*Task/Remote*Task 在工具调用中的通知。
    return getQueuedCommandAttachments(queuedCommands)
  }

  // 这会减慢提交速度
  // TODO: 在用户输入时计算附件，而不是在这里（尽管我们也对 slash 命令提示使用此函数）
  const abortController = createAbortController()
  const timeoutId = setTimeout((ac) => ac.abort(), 1000, abortController)
  const context = {
    ...toolUseContext,
    abortController,
  }
  const isMainThread = !toolUseContext.agentId

  // 响应用户输入而添加的附件
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () => processAtMentionedFiles(input, context)),
        maybe('mcp_resources', () => processMcpResourceAttachments(input, context)),
        maybe('agent_mentions', () =>
          Promise.resolve(
            processAgentMentions(input, toolUseContext.options.agentDefinitions.activeAgents),
          ),
        ),
        // 第 0 轮的技能发现（用户输入作为信号）。轮间
        // 发现通过 query.ts 中的 startSkillDiscoveryPrefetch 运行，
        // 由 write-pivot 检测门控 — 见 skillSearch/prefetch.ts。
        // 此处的 feature() 使 DCE 能从外部构建中丢弃 'skill_discovery' 字符串
        //（及其调用的函数）。
        //
        // skipSkillDiscovery 门控排除 SKILL.md 扩展路径
        //（getMessagesForPromptSlashCommand）。当调用技能时，
        // 其 SKILL.md 内容作为 `input` 传入此处以提取 @-mentions —
        // 但该内容不是用户意图，不应触发发现。
        // 没有此门控时，110KB 的 SKILL.md 会在每次技能调用时
        // 触发约 3.3s 的分块 AKI 查询（会话 13a9afae）。
        ...(feature('EXPERIMENTAL_SKILL_SEARCH')
          ? skillSearchModules && !options?.skipSkillDiscovery
            ? [
                maybe('skill_discovery', () =>
                  (
                    skillSearchModules!.prefetch as { getTurnZeroSkillDiscovery: Function }
                  ).getTurnZeroSkillDiscovery(input, messages ?? [], context),
                ),
              ]
            : []
          : []),
      ]
    : []

  // 先处理用户输入附件（包括 @提到的文件）
  // 这确保文件在 nested_memory 处理之前添加到 nestedMemoryAttachmentTriggers
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // 子代理中可用的线程安全附件
  // 注意：这些必须在 userInputAttachments 完成后创建，以确保
  // nestedMemoryAttachmentTriggers 在 getNestedMemoryAttachments 运行之前已填充
  const allThreadAttachments = [
    // queuedCommands 已由 query.ts 中的 drain gate 进行代理作用域 —
    // 主线程获取 agentId===undefined，子代理获取自己的 agentId。
    // 必须对所有线程运行，否则子代理通知会流失到虚空
    //（被 removeFromQueue 从队列中移除但从未附加）。
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () => Promise.resolve(getDateChangeAttachments(messages))),
    maybe('ultrathink_effort', () => Promise.resolve(getUltrathinkEffortAttachment(input))),
    maybe('workflow_reminder', () =>
      Promise.resolve(getWorkflowReminderAttachment(input, toolUseContext)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread ? 'attachments_main' : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    // relevant_memories 已移至异步预取（startRelevantMemoryPrefetch）
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    // 轮间技能发现现在通过 startSkillDiscoveryPrefetch 运行
    //（query.ts，与主轮次并发）。此前驻留在此的阻塞调用
    // 是 assistant_turn 信号 — 97% 的这些 Haiku 调用在生产环境中
    // 什么都没找到。预取 + 收集时 await 取代了它；
    // 见 src/services/skill-search/prefetch.ts。
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(true
      ? [
          maybe('auto_mode', () => getAutoModeAttachments(messages, toolUseContext)),
          maybe('auto_mode_exit', () => getAutoModeExitAttachment(toolUseContext)),
        ]
      : []),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
          // 跳过 session_memory 分叉代理的 teammate 邮箱。
          // 它与 leader 共享 AppState.teamContext，因此 isTeamLead 解析为
          // true，它会将 leader 的 DM 读取并标记为已读作为临时附件，
          // 静默窃取本应作为永久轮次传递的消息。
          ...((querySource as string) === 'session_memory'
            ? []
            : [
                maybe('teammate_mailbox', async () =>
                  getTeammateMailboxAttachments(toolUseContext),
                ),
              ]),
          maybe('team_context', async () => getTeamContextAttachment(messages ?? [])),
        ]
      : []),
    maybe('agent_pending_messages', async () => getAgentPendingMessageAttachments(toolUseContext)),
    maybe('critical_system_reminder', () =>
      Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext)),
    ),
    ...(feature('COMPACTION_REMINDERS')
      ? [
          maybe('compaction_reminder', () =>
            Promise.resolve(
              getCompactionReminderAttachment(messages ?? [], toolUseContext.options.mainLoopModel),
            ),
          ),
        ]
      : []),
  ]

  // 语义上仅用于主对话或不具备并发安全实现的附件
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () => getSelectedLinesFromIDE(ideSelection, toolUseContext)),
        maybe('ide_opened_file', async () => getOpenedFileFromIDE(ideSelection, toolUseContext)),
        maybe('output_style', async () => Promise.resolve(getOutputStyleAttachment())),
        maybe('diagnostics', async () => getDiagnosticAttachments(toolUseContext)),
        maybe('lsp_diagnostics', async () => getLSPDiagnosticAttachments(toolUseContext)),
        maybe('unified_tasks', async () => getUnifiedTaskAttachments(toolUseContext)),
        maybe('async_hook_responses', async () => getAsyncHookResponseAttachments()),
        maybe('token_usage', async () =>
          Promise.resolve(
            getTokenUsageAttachment(messages ?? [], toolUseContext.options.mainLoopModel),
          ),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd)),
        ),
        maybe('output_token_usage', async () => Promise.resolve(getOutputTokenUsageAttachment())),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // 并行处理线程和主线程附件（它们之间无依赖）
  const [threadAttachmentResults, mainThreadAttachmentResults] = await Promise.all([
    Promise.all(allThreadAttachments),
    Promise.all(mainThreadAttachments),
  ])
  clearTimeout(timeoutId)
  // 防御性：泄露 [undefined] 的 getter 会使下方的 .map(a => a.type) 崩溃。
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  ].filter((a): a is Attachment => a !== undefined && a !== null)
}

export async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) 返回 undefined，因此 .length 会抛出异常
      const attachmentSizeBytes = result
        .filter((a) => a !== undefined && a !== null)
        .reduce((total, attachment) => {
          return total + jsonStringify(attachment).length
        }, 0)
      logEvent('zy_attachment_compute_duration', {
        label,
        duration_ms: duration,
        attachment_size_bytes: attachmentSizeBytes,
        attachment_count: result.length,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    return result
  } catch (e) {
    const duration = Date.now() - startTime
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      logEvent('zy_attachment_compute_duration', {
        label,
        duration_ms: duration,
        error: true,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    logError(e)
    // 对于 Ant 用户，记录完整错误以帮助调试
    logAntError(`Attachment error in ${label}`, e)
    return []
  }
}

export const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // 将 'prompt' 和 'task-notification' 命令都包含为附件。
  // 在主动代理循环期间，task-notification 命令否则会
  // 永久停留在队列中（查询活跃时 useQueueProcessor 无法运行），
  // 导致 hasPendingNotifications() 返回 true 且 Sleep 以
  // 0ms 持续时间立即唤醒，形成无限循环。
  const filtered = queuedCommands.filter((_) => INLINE_NOTIFICATION_MODES.has(_.mode))
  return Promise.all(
    filtered.map(async (_) => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlock> = _.value
      if (imageBlocks.length > 0) {
        // 构建包含文本 + 图像的内容块数组，使模型能看到它们
        const textValue = typeof _.value === 'string' ? _.value : extractTextContent(_.value, '\n')
        prompt = [
          {
            type: 'text' as const,
            text: textValue,
          },
          ...imageBlocks,
        ]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

export function getAgentPendingMessageAttachments(toolUseContext: ToolUseContext): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!agentId) {
    return []
  }
  const drained = drainPendingMessages(
    agentId,
    toolUseContext.getAppState,
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState,
  )
  return drained.map((msg) => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: {
      kind: 'coordinator' as const,
    },
    isMeta: true,
  }))
}

export async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlock[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async (img) => {
      const imageBlock: ImageBlock = {
        type: 'image',
        mimeType: (img.mediaType || 'image/png') as ImageSource['mediaType'],
        data: img.content,
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}

export function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  // 向后迭代以查找最近的 plan_mode 附件。
  // 统计人工轮次（非 meta、非工具结果的用户消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每个工具轮次调用 getAttachmentMessages，
  // 因此统计 assistant 消息会每 5 个工具调用触发一次提醒，而不是每 5 个人工轮次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment.type === 'plan_mode' || message.attachment.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }
  return {
    turnCount: turnsSinceLastAttachment,
    foundPlanModeAttachment,
  }
}

/**
 * 统计自上次 plan_mode_exit 以来（或从头开始如果无 exit）的 plan_mode 附件数量。
 * 这确保了重新进入 plan mode 时 full/sparse 周期会重置。
 */
export function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  // 向后迭代 — 如果遇到 plan_mode_exit，停止计数
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break // 在最后一次退出处停止计数
      }
      if (message.attachment.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

export async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'plan') {
    return []
  }

  // 检查是否应基于轮次计数附加（首轮除外）
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } = getPlanModeAttachmentTurnCount(messages)
    // 仅在我们已发送过 plan_mode 附件时才限流
    // 在 plan mode 的首轮，始终附加
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }
  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)
  const attachments: Attachment[] = []

  // 检查重新进入：标志已设置且计划文件存在
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({
      type: 'plan_mode_reentry',
      planFilePath,
    })
    setHasExitedPlanMode(false) // 清除标志 — 一次性指导
  }

  // 确定这是完整还是稀疏提醒
  // 在第 1、6、11... 轮次完整提醒（每 N 次附件）
  const attachmentCount = countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount % PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? 'full'
      : 'sparse'

  // 始终添加主 plan_mode 附件
  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })
  return attachments
}

/**
 * 如果刚退出 plan mode，返回 plan_mode_exit 附件。
 * 这是一次性通知，告知模型它不再处于 plan mode。
 */
export async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 仅在标志已设置时触发（我们刚退出 plan mode）
  if (!needsPlanModeExitAttachment()) {
    return []
  }
  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  // 清除标志 — 这是一次性通知
  setNeedsPlanModeExitAttachment(false)
  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  // 注意：技能发现不会在 plan 退出时触发。到计划写好时，
  // 已经太晚了 — 模型应该在规划期间就有相关技能。
  // 触发规划的用户消息信号已经在正确的时刻触发。
  return [
    {
      type: 'plan_mode_exit',
      planFilePath,
      planExists,
    },
  ]
}

export function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  // 向后迭代以查找最近的 auto_mode 附件。
  // 统计人工轮次（非 meta、非工具结果的用户消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每个工具轮次调用 getAttachmentMessages，
  // 因此如果统计 assistant 消息，一个有 100 次工具调用的单个人工轮次
  // 会触发约 20 次提醒。自动模式的目标用例是长代理会话，
  // 每会话累积 60-105 次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (message?.type === 'attachment' && message.attachment.type === 'auto_mode') {
      foundAutoModeAttachment = true
      break
    } else if (message?.type === 'attachment' && message.attachment.type === 'auto_mode_exit') {
      // 退出重置限流 — 视为没有先前的附件存在
      break
    }
  }
  return {
    turnCount: turnsSinceLastAttachment,
    foundAutoModeAttachment,
  }
}

/**
 * 统计自上次 auto_mode 退出以来的 auto_mode 附件数量（如无退出则从开始统计）。
 * 这确保重新进入自动模式时完整/稀疏周期重置。
 */
export function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

export async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'auto'
  const inPlanWithAuto =
    permissionContext.mode === 'plan' && (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  // 检查是否应基于轮次计数附加（首轮除外）
  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } = getAutoModeAttachmentTurnCount(messages)
    // 仅在我们已发送过 auto_mode 附件时才限流
    // 在 auto mode 的首轮，始终附加
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  // 判断这应该是完整还是稀疏提醒
  const attachmentCount = countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount % AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? 'full'
      : 'sparse'
  return [
    {
      type: 'auto_mode',
      reminderType,
    },
  ]
}

/**
 * 如果刚退出 auto mode，返回 auto_mode_exit 附件。
 * 这是一次性通知，告诉模型它不再处于自动模式。
 */
export async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }
  const appState = toolUseContext.getAppState()
  // 当 auto 仍处于活跃状态时抑制 — 覆盖 mode==='auto' 和
  // plan-with-auto-active（此时 mode==='plan' 但分类器仍在运行）。
  if (
    appState.toolPermissionContext.mode === 'auto' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }
  setNeedsAutoModeExitAttachment(false)
  return [
    {
      type: 'auto_mode_exit',
    },
  ]
}

/**
 * 检测本地日期自上一轮以来是否发生变化（用户编码跨过午夜），
 * 并发出附件通知模型。
 *
 * date_change 附件追加在对话末尾，使模型了解新日期而无需修改缓存前缀。
 * messages[0]（来自 getUserContext → prependUserContext）有意保留过时日期——
 * 清除该缓存会重新生成前缀，并在下一轮将整个对话转为 cache_creation
 *（每次午夜跨越约 920K 有效 token）。
 *
 * 导出用于测试——缓存清除移除的回归保护。
 */
export function getDateChangeAttachments(messages: Message[] | undefined): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()
  if (lastDate === null) {
    // 首轮 — 仅记录，无需附件
    setLastEmittedDate(currentDate)
    return []
  }
  if (currentDate === lastDate) {
    return []
  }
  setLastEmittedDate(currentDate)

  // Assistant 模式：将昨天的 transcript 刷新到每日文件，使 /dream 技能（本地 1-5am）
  // 即使今天没有 compact 触发也能找到它。触发即忘；writeSessionTranscriptSegment
  // 按消息时间戳分桶，因此多天空隔也能正确刷新每一天。
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate)
    }
  }
  return [
    {
      type: 'date_change',
      newDate: currentDate,
    },
  ]
}

export function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('zy_ultrathink', {})
  return [
    {
      type: 'ultrathink_effort',
      level: 'high',
    },
  ]
}

export let ultracodeReminderCount = 0

export function getWorkflowReminderAttachment(
  input: string | null,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (!feature('WORKFLOW_SCRIPTS')) {
    return []
  }
  const attachments: Attachment[] = []
  const effortValue = toolUseContext.getAppState().effortValue

  if (isOrchestrateEffort(effortValue)) {
    ultracodeReminderCount++
    const kind = ultracodeReminderCount === 1 ? 'ultracode_enter_full' : 'ultracode_enter_light'
    attachments.push({ type: 'workflow_reminder', reminderKind: kind })
  } else if (ultracodeReminderCount > 0) {
    ultracodeReminderCount = 0
    attachments.push({ type: 'workflow_reminder', reminderKind: 'ultracode_exit' })
  }

  if (input && hasWorkflowKeyword(input)) {
    attachments.push({ type: 'workflow_reminder', reminderKind: 'workflow_keyword_request' })
  }

  return attachments
}
