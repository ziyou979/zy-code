import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { relative } from 'node:path'
import { getCwd } from 'src/utils/cwd.js'
import { addInvokedSkill } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from '../types/logs.js'
import type { Message, NormalizedMessage, NormalizedUserMessage } from '../types/message.js'
import { PERMISSION_MODES } from '../types/permissions.js'
import { suppressNextSkillListing } from './attachments.js'
import { copyFileHistoryForResume, type FileHistorySnapshot } from './fileHistory.js'
import { logError } from './log.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from './sessionStorage.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'

// 死代码消除：ant 专属的工具名通过条件 require 引入，
// 避免其字符串泄漏到外部构建产物中。静态 import 会始终被打包。
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js'))
        .BRIEF_TOOL_NAME
    : null
const LEGACY_BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js'))
        .LEGACY_BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../tools/SendUserFileTool/prompt.js') as typeof import('../tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 将旧版附件类型转换为当前类型，以实现向后兼容
 */
function migrateLegacyAttachmentTypes(message: Message): Message {
  if (message.type !== 'attachment') {
    return message
  }

  const attachment = message.attachment as {
    type: string
    [key: string]: unknown
  } // 处理不在当前类型系统中的旧版类型

  // 转换旧版附件类型
  if (attachment.type === 'new_file') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'file',
        displayPath: relative(getCwd(), attachment.filename as string),
      },
    } as unknown as SerializedMessage // 因为已知结构正确，所以强制转换整条消息
  }

  if (attachment.type === 'new_directory') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'directory',
        displayPath: relative(getCwd(), attachment.path as string),
      },
    } as unknown as SerializedMessage // 因为已知结构正确，所以强制转换整条消息
  }

  // 为旧会话中缺少 displayPath 的附件回填该字段
  if (!('displayPath' in attachment)) {
    const path =
      'filename' in attachment
        ? (attachment.filename as string)
        : 'path' in attachment
          ? (attachment.path as string)
          : 'skillDir' in attachment
            ? (attachment.skillDir as string)
            : undefined
    if (path) {
      return {
        ...message,
        attachment: {
          ...attachment,
          displayPath: relative(getCwd(), path),
        },
      } as Message
    }
  }

  return message
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/**
 * 将日志文件中的消息反序列化为 REPL 期望的格式。
 * 过滤未解析的 tool use、孤立的 thinking 消息，并在最后一条消息来自用户时
 * 追加一条合成的 assistant 哨兵消息。
 * @internal 仅为测试导出 - 请使用 loadConversationForResume 代替
 */
export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

/**
 * 类似 deserializeMessages，但同时检测会话是否在轮次中途被中断。
 * 用于 SDK resume 路径，在网关触发重启后自动继续被中断的轮次。
 * @internal 仅为测试导出
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  try {
    // 在处理前先转换旧版附件类型
    const migratedMessages = serializedMessages.map(migrateLegacyAttachmentTypes)

    // 从反序列化的用户消息中剥离无效的 permissionMode 值。
    // 该字段是从磁盘读取的未经验证的 JSON，可能包含来自不同构建版本的模式。
    const validModes = new Set<string>(PERMISSION_MODES)
    for (const msg of migratedMessages) {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        !validModes.has(msg.permissionMode)
      ) {
        msg.permissionMode = undefined
      }
    }

    // 过滤未解析的 tool use 及其后续的合成消息
    const filteredToolUses = filterUnresolvedToolUses(migratedMessages) as NormalizedMessage[]

    // 过滤孤立的仅含 thinking 的 assistant 消息，这些消息在 resume 时会导致 API 错误。
    // 当流式传输为每个 content block 生成独立消息，且穿插的用户消息阻止了
    // 按 message.id 正确合并时，就会出现此情况。
    const filteredThinking = filterOrphanedThinkingOnlyMessages(
      filteredToolUses,
    ) as NormalizedMessage[]

    // 过滤仅包含空白文本内容的 assistant 消息。
    // 当模型在 thinking 前输出 "\n\n"，而用户在流式传输中途取消时会发生此情况。
    const filteredMessages = filterWhitespaceOnlyAssistantMessages(
      filteredThinking,
    ) as NormalizedMessage[]

    const internalState = detectTurnInterruption(filteredMessages)

    // 通过追加一条合成的继续消息，将轮次中途中断转换为 interrupted_prompt。
    // 这统一了两种中断类型，使消费者只需处理 interrupted_prompt。
    let turnInterruptionState: TurnInterruptionState
    if (internalState.kind === 'interrupted_turn') {
      const [continuationMessage] = normalizeMessages([
        createUserMessage({
          content: 'Continue from where you left off.',
          isMeta: true,
        }),
      ])
      filteredMessages.push(continuationMessage!)
      turnInterruptionState = {
        kind: 'interrupted_prompt',
        message: continuationMessage!,
      }
    } else {
      turnInterruptionState = internalState
    }

    // 在最后一条用户消息之后追加合成的 assistant 哨兵消息，
    // 以确保在不执行 resume 操作时 conversation 仍然是 API 合法的。
    // 跳过尾部的 system/progress 消息，紧接在用户消息之后插入，
    // 这样 removeInterruptedMessage 的 splice(idx, 2) 能正确移除对应的消息对。
    const lastRelevantIdx = filteredMessages.findLastIndex(
      (m) => m.type !== 'system' && m.type !== 'progress',
    )
    if (lastRelevantIdx !== -1 && filteredMessages[lastRelevantIdx]!.type === 'user') {
      filteredMessages.splice(
        lastRelevantIdx + 1,
        0,
        createAssistantMessage({
          content: NO_RESPONSE_REQUESTED,
        }) as NormalizedMessage,
      )
    }

    return { messages: filteredMessages, turnInterruptionState }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

/**
 * 检测结果的内部三态类型，在将 interrupted_turn
 * 转换为带有合成继续消息的 interrupted_prompt 之前使用。
 */
type InternalInterruptionState = TurnInterruptionState | { kind: 'interrupted_turn' }

/**
 * 根据过滤后的最后一条消息，判断 conversation 是否在轮次中途被中断。
 * 如果最后一条消息是 assistant（在过滤未解析的 tool_uses 之后），则视为已完成的轮次，
 * 因为在流式路径中持久化消息的 stop_reason 始终为 null。
 *
 * 在查找最后一条与轮次相关的消息时会跳过 system 和 progress 消息——
 * 它们是记账类辅助产物，不应掩盖真正的中断。附件被视为轮次的一部分予以保留。
 */
function detectTurnInterruption(messages: NormalizedMessage[]): InternalInterruptionState {
  if (messages.length === 0) {
    return { kind: 'none' }
  }

  // 查找最后一条与轮次相关的消息，跳过 system/progress 及合成的 API 错误 assistant 消息。
  // 错误类 assistant 消息已在发送 API 前被过滤（normalizeMessagesForAPI）——
  // 在此处跳过它们可以让 auto-resume 在重试耗尽后触发，
  // 而不是将错误消息误判为已完成的轮次。
  const lastMessageIdx = messages.findLastIndex(
    (m) =>
      m.type !== 'system' &&
      m.type !== 'progress' &&
      !(m.type === 'assistant' && m.isApiErrorMessage),
  )
  const lastMessage = lastMessageIdx !== -1 ? messages[lastMessageIdx] : undefined

  if (!lastMessage) {
    return { kind: 'none' }
  }

  if (lastMessage.type === 'assistant') {
    // 在流式路径中，持久化消息的 stop_reason 始终为 null，
    // 因为消息是在 content_block_stop 时记录的，此时 message_delta 尚未传递 stop_reason。
    // 在 filterUnresolvedToolUses 已移除带有未匹配 tool_uses 的 assistant 消息后，
    // 如果最后一条消息仍是 assistant，则表明该轮次很可能已正常完成。
    return { kind: 'none' }
  }

  if (lastMessage.type === 'user') {
    if (lastMessage.isMeta || lastMessage.isCompactSummary) {
      return { kind: 'none' }
    }
    if (isToolUseResultMessage(lastMessage)) {
      // Brief 模式 (#20467) 会省略末尾的 assistant 文本块，因此一个完成的
      // brief 模式轮次合理地以 SendUserMessage 的 tool_result 结尾。
      // 如果没有此检查，resume 会将每个 brief 模式会话误判为轮次中途中断，
      // 并在用户真正的下一条 prompt 之前注入一条幻影的
      // "Continue from where you left off."。向前回溯一步找到发起的 tool_use。
      if (isTerminalToolResult(lastMessage, messages, lastMessageIdx)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    // 纯文本用户 prompt —— 助手尚未开始响应
    return { kind: 'interrupted_prompt', message: lastMessage }
  }

  if (lastMessage.type === 'attachment') {
    // 附件是用户轮次的一部分——用户提供了上下文但助手从未响应。
    return { kind: 'interrupted_turn' }
  }

  return { kind: 'none' }
}

/**
 * 判断此 tool_result 是否是合理终止轮次的工具的输出。
 * SendUserMessage 是典型案例：在 brief 模式下，调用它是轮次的最终动作——
 * 不再有后续的 assistant 文本（#20467 移除了它）。
 * 如果转录在此处结束，说明轮次已完成，而非在工具执行中途被终止。
 *
 * 向前回溯查找此 result 所属的 assistant tool_use 并检查其名称。
 * 匹配的 tool_use 通常是紧接在前面的相关消息（filterUnresolvedToolUses
 * 已移除了未配对的），但我们仍然向前遍历以防 system/progress 噪声穿插其中。
 */
function isTerminalToolResult(
  result: NormalizedUserMessage,
  messages: NormalizedMessage[],
  resultIdx: number,
): boolean {
  const content = result.message.content
  if (!Array.isArray(content)) {
    return false
  }
  const block = content[0]
  if (block?.type !== 'tool_result') {
    return false
  }
  const toolUseId = block.toolCallId

  for (let i = resultIdx - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') {
      continue
    }
    for (const b of msg.message.content) {
      if (b.type === 'tool_call' && b.id === toolUseId) {
        return (
          b.name === BRIEF_TOOL_NAME ||
          b.name === LEGACY_BRIEF_TOOL_NAME ||
          b.name === SEND_USER_FILE_TOOL_NAME
        )
      }
    }
  }
  return false
}

/**
 * 从消息中的 invoked_skills 附件恢复 skill 状态。
 * 确保 skill 在 resume 后的压缩过程中得以保留。
 * 如果没有此操作，当 resume 后再次发生压缩时，skill 将会丢失，
 * 因为 STATE.invokedSkills 会是空的。
 * @internal 仅为测试导出 - 请使用 loadConversationForResume 代替
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment') {
      continue
    }
    if (message.attachment.type === 'invoked_skills') {
      for (const skill of (message.attachment as any).skills) {
        if (skill.name && skill.path && skill.content) {
          // resume 仅发生在主会话中，因此 agentId 为 null
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    // 前一个进程已注入了 skills-available 提醒——它在模型即将看到的转录中。
    // sentSkillNames 是进程局部的，如果不做处理，每次 resume 都会重复声明
    // 相同的约 600 个 token。一次性闩锁；在第一次附件遍历时消费。
    if (message.attachment.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }
}

/**
 * 通过路径对 transcript jsonl 进行链式遍历。与 loadFullLog 内部运行的序列相同——
 * loadTranscriptFile -> 查找最新的非侧链叶节点 -> buildConversationChain
 * -> removeExtraFields——只是从任意路径而非从 sid 派生路径开始。
 *
 * leafUuids 由 loadTranscriptFile 填充，表示"没有其他消息的 parentUuid
 * 指向的 uuid"——即链的末端。可能有多个（侧链、孤立节点）；
 * 最新的非侧链节点就是主 conversation 的终点。
 */
export async function loadMessagesFromJsonlPath(path: string): Promise<{
  messages: SerializedMessage[]
  sessionId: UUID | undefined
}> {
  const { messages: byUuid, leafUuids } = await loadTranscriptFile(path)
  let tip: (typeof byUuid extends Map<UUID, infer T> ? T : never) | null = null
  let tipTs = 0
  for (const m of byUuid.values()) {
    if (m.isSidechain || !leafUuids.has(m.uuid as any)) {
      continue
    }
    const ts = new Date(m.timestamp).getTime()
    if (ts > tipTs) {
      tipTs = ts
      tip = m
    }
  }
  if (!tip) {
    return { messages: [], sessionId: undefined }
  }
  const chain = buildConversationChain(byUuid, tip)
  return {
    messages: removeExtraFields(chain),
    // 叶节点的 sessionId —— fork 的会话会从源 transcript 复制 chain[0]，
    // 因此根节点保留源会话的 ID。与 loadFullLog 的 mostRecentLeaf.sessionId 一致。
    sessionId: tip.sessionId as UUID | undefined,
  }
}

/**
 * 从多种来源加载 conversation 以进行 resume。
 * 这是加载和反序列化 conversation 的集中化函数。
 *
 * @param source - 加载来源：
 *   - undefined: 加载最近的 conversation
 *   - string: 要加载的 session ID
 *   - LogOption: 已加载的 conversation
 * @param sourceJsonlFile - 备选：transcript jsonl 的路径。
 *   当 --resume 接收到 .jsonl 路径时使用（cli/print.ts 根据后缀路由），
 *   通常用于 transcript 位于当前项目目录之外的跨目录 resume 场景。
 * @returns 包含反序列化消息和原始日志的对象，未找到时返回 null
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  // 用于恢复 agent 上下文的会话元数据
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  // 会话文件的完整路径（用于跨目录 resume）
  fullPath?: string
} | null> {
  try {
    let log: LogOption | null = null
    let messages: Message[] | null = null
    let sessionId: UUID | undefined

    if (source === undefined) {
      // --continue: 最近的会话，跳过正在主动写入自身 transcript 的
      // 活跃 --bg/daemon 会话。
      const logsPromise = loadMessageLogs()
      let skip = new Set<string>()
      if (feature('BG_SESSIONS')) {
        try {
          const udsClient = await import('./udsClient.js')
          const live = await (udsClient as any).listAllLiveSessions()
          skip = new Set(
            live.flatMap((s) =>
              s.kind && s.kind !== 'interactive' && s.sessionId ? [s.sessionId] : [],
            ),
          )
        } catch {
          // UDS 不可用——将所有会话视为可继续的
        }
      }
      const logs = await logsPromise
      log =
        logs.find((l) => {
          const id = getSessionIdFromLog(l)
          return !id || !skip.has(id)
        }) ?? null
    } else if (sourceJsonlFile) {
      // --resume 带有 .jsonl 路径（cli/print.ts 根据后缀路由）。
      // 与下方 sid 分支相同的链式遍历——只是起始路径不同。
      const loaded = await loadMessagesFromJsonlPath(sourceJsonlFile)
      messages = loaded.messages
      sessionId = loaded.sessionId
    } else if (typeof source === 'string') {
      // 按 ID 加载指定会话
      log = await getLastSessionLog(source as UUID)
      sessionId = source as UUID
    } else {
      // 已持有 LogOption
      log = source
    }

    if (!log && !messages) {
      return null
    }

    if (log) {
      // 为精简日志加载完整消息
      if (isLiteLog(log)) {
        log = await loadFullLog(log)
      }

      // 先确定 sessionId，以便传递给后续的复制函数
      if (!sessionId) {
        sessionId = getSessionIdFromLog(log) as UUID
      }
      // 传递原始 session ID，确保 plan slug 关联到正在 resume 的会话，
      // 而非 resume 之前的临时 session ID
      if (sessionId) {
        await copyPlanForResume(log, asSessionId(sessionId))
      }

      // 为 resume 复制文件历史
      void copyFileHistoryForResume(log)

      messages = log.messages
      checkResumeConsistency(messages)
    }

    // 在反序列化之前从 invoked_skills 附件恢复 skill 状态。
    // 确保 skill 在 resume 后的多次压缩循环中得以存续。
    restoreSkillStateFromMessages(messages!)

    // 反序列化消息，处理未解析的 tool use 并确保格式正确
    const deserialized = deserializeMessagesWithInterruptDetection(messages!)
    messages = deserialized.messages

    // 为 resume 处理会话启动钩子
    const hookMessages = await processSessionStartHooks('resume', { sessionId })

    // 将钩子消息追加到 conversation
    messages.push(...hookMessages)

    return {
      messages,
      turnInterruptionState: deserialized.turnInterruptionState,
      fileHistorySnapshots: log?.fileHistorySnapshots,
      attributionSnapshots: log?.attributionSnapshots,
      contentReplacements: log?.contentReplacements,
      contextCollapseCommits: log?.contextCollapseCommits,
      contextCollapseSnapshot: log?.contextCollapseSnapshot,
      sessionId,
      // 包含会话元数据以在 resume 时恢复 agent 上下文
      agentName: log?.agentName,
      agentColor: log?.agentColor,
      agentSetting: log?.agentSetting,
      customTitle: log?.customTitle,
      tag: log?.tag,
      mode: log?.mode,
      worktreeSession: log?.worktreeSession,
      prNumber: log?.prNumber,
      prUrl: log?.prUrl,
      prRepository: log?.prRepository,
      // 包含完整路径以支持跨目录 resume
      fullPath: log?.fullPath,
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}
