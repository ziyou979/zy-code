import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
// readFileTailSync 所需的同步 fs 原语 — 与上面的 fs/promises 导入分开。
// 按 AGENTS.md 风格使用具名导入（非通配符）；与异步后缀命名无冲突。
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { builtInCommandNames } from '../commands.js'
import { COMMAND_NAME_TAG, TICK_TAG } from '../constants/xml.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import * as sessionIngress from '../services/api/sessionIngress.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import { type AgentId, asAgentId, asSessionId, type SessionId } from '../types/ids.js'
import type { AttributionSnapshotMessage } from '../types/logs.js'
import {
  type ContentReplacementEntry,
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type LogOption,
  type PersistedWorktreeSession,
  type SerializedMessage,
  sortLogs,
  type TranscriptMessage,
} from '../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'
import { uniq } from './array.js'
import { registerCleanup } from './cleanupRegistry.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getZyConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getWorktreePaths } from './getWorktreePaths.js'
import { getBranch } from './git.js'
import { gracefulShutdownSync, isShuttingDown } from './gracefulShutdown.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { extractTag, isCompactBoundaryMessage } from './messages.js'
import { sanitizePath } from './path.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { validateUuid } from './uuid.js'
export {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  MAX_TRANSCRIPT_READ_BYTES,
  setAgentTranscriptSubdir,
} from './sessionStorage/paths.js'
export {
  getNodeEnv,
  getUserType,
  isCustomTitleEnabled,
} from './sessionStorage/env.js'
import { getEntrypoint, getNodeEnv, getUserType } from './sessionStorage/env.js'
export {
  isChainParticipant,
  isEphemeralToolProgress,
  isTranscriptMessage,
  sessionIdExists,
} from './sessionStorage/predicates.js'
import { isLegacyProgressEntry } from './sessionStorage/predicates.js'
export {
  deleteRemoteAgentMetadata,
  listRemoteAgentMetadata,
  readAgentMetadata,
  readRemoteAgentMetadata,
  writeAgentMetadata,
  writeRemoteAgentMetadata,
} from './sessionStorage/agentMetadata.js'
export type {
  AgentMetadata,
  RemoteAgentMetadata,
} from './sessionStorage/agentMetadata.js'
export {
  buildConversationChain,
  checkResumeConsistency,
  getFirstMeaningfulUserMessageTextContent,
  removeExtraFields,
} from './sessionStorage/chain.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildAttributionSnapshotChain,
  buildConversationChain,
  buildFileHistorySnapshotChain,
  countVisibleMessages,
  extractFirstPrompt,
  findLatestMessage,
} from './sessionStorage/chain.js'
import {
  getAgentMetadataPath,
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getRemoteAgentMetadataPath,
  getRemoteAgentsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from './sessionStorage/paths.js'
export {
  cleanMessagesForLogging,
  clearSessionMessagesCache,
  doesMessageExistInSession,
  enrichLogs,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  findUnresolvedToolUse,
  getAgentTranscript,
  getLastSessionLog,
  getSessionFilesWithMtime,
  getSessionIdFromLog,
  isLiteLog,
  isLoggableMessage,
  loadAllLogsFromSessionFile,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadAllSubagentTranscriptsFromDisk,
  loadFullLog,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  loadSubagentTranscripts,
  loadTranscriptFile,
  loadTranscriptFromFile,
  searchSessionsByCustomTitle,
} from './sessionStorage/logLoading.js'
export type { SessionLogResult } from './sessionStorage/logLoading.js'
import {
  cleanMessagesForLogging,
  getSessionMessages,
  loadSessionFile,
  loadTranscriptFile,
  loadTranscriptFromFile,
  MAX_TOMBSTONE_REWRITE_BYTES,
  repairBrokenParentUuidChains,
} from './sessionStorage/logLoading.js'
import {
  isChainParticipant,
  isTranscriptMessage,
} from './sessionStorage/predicates.js'
import {
  getFirstMeaningfulUserMessageTextContent,
} from './sessionStorage/chain.js'
export {
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './sessionStorage/project.js'
import { getProject } from './sessionStorage/project.js'

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

// 在传递给 insertMessageChain 之前过滤已记录的消息。
// 如果不这样做，压缩后 messagesToKeep（与压缩前消息相同的 UUID）
// 被 appendEntry 去重跳过，但仍会推进 insertMessageChain 中的 parentUuid
// 游标，导致新消息从压缩前的 UUID 链接而非压缩后的摘要 — 使 compact boundary 成为孤儿。
//
// `startingParentUuidHint`：由 useLogMessages 使用，传递前一个增量切片的父级，
// 避免 O(n) 扫描重新发现它。
//
// 跳过跟踪：已记录的消息仅在它们形成前缀（出现在任何新消息之前）时
// 才作为父级跟踪。这处理了两种情况：
//  - 增长数组调用者（QueryEngine、queryHelpers、LocalMainSessionTask、
//    trajectory）：已记录消息总是前缀 → 被跟踪 → 新消息的
//    父链正确。
//  - 压缩（useLogMessages）：新的 CB/摘要先出现，然后是已记录的
//    messagesToKeep → 不是前缀 → 不跟踪 → CB 获得 parentUuid=null
//    （正确：在 compact boundary 处截断 --continue 链）。
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      // 仅跟踪形成前缀的跳过消息。压缩后，
      // messagesToKeep 出现在新的 CB/摘要之后，因此跳过它们。
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }
  // 返回最后实际记录的链参与者的 UUID，或在没有新链参与者被记录时
  // 返回前缀跟踪的 UUID。这让调用者（useLogMessages）即使在切片
  // 全部已记录（回退、/resume 场景，其中每条消息都已在 messageSet 中）
  // 时也能维护正确的父链。progress 被跳过 — 它被写入 JSONL
  // 但没有任何东西链接到它（参见 isChainParticipant）。
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

/**
 * 通过 UUID 从 transcript 中删除一条消息。
 * 当收到孤立消息的 tombstone 时使用。
 */
export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(messageId, snapshot, isSnapshotUpdate)
}

export async function recordAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  await getProject().insertContentReplacement(replacements, agentId)
}

/**
 * 在 switchSession/regenerateSessionId 之后重置 session 文件指针。
 * 新文件在首条 user/assistant 消息时懒创建。
 */
export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

/**
 * 在 --continue/--resume（非 fork）之后采纳现有的 session 文件。
 * 在 switchSession + resetSessionFilePointer + restoreSessionMetadata 之后调用：
 * getTranscriptPath() 现在从切换后的 sessionId 派生恢复文件的路径，
 * 缓存保存最终 metadata（--name 标题、恢复的 mode/tag/agent）。
 *
 * 在此处设置 sessionFile — 而非等待首条用户消息时的
 * materializeSessionFile — 使退出清理处理器的 reAppendSessionMetadata
 * 可以运行（当 sessionFile 为 null 时它会中止）。没有这个，
 * `-c -n foo` + 在消息之前退出会丢失标题：内存缓存正确但从未写入。
 * 恢复的文件已存在于磁盘（我们从中加载），因此不会像新 --name
 * session 那样创建孤儿。
 *
 * skipTitleRefresh：restoreSessionMetadata 在微秒前从相同的磁盘读取填充了
 * 缓存，因此此处从尾部刷新是无操作 — 除非使用了 --name，
 * 那样会用过时的磁盘值覆盖新鲜的 CLI 标题。此次写入后，
 * 磁盘 == 缓存，后续调用（压缩、退出清理）正常吸收 SDK 写入。
 */
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
}

/**
 * 将 context-collapse 提交 entry 追加到 transcript。每次提交一个 entry，
 * 按提交顺序。恢复时将它们收集到有序数组中，
 * 交给 restoreFromEntries() 重建提交日志。
 */
export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) {
    return
  }
  await getProject().appendEntry({
    type: 'marble-origami-commit',
    sessionId,
    ...commit,
  })
}

/**
 * 快照 staged 队列 + spawn 状态。在每个 ctx-agent spawn 解析后写入
 * （当 staged 内容可能已变化时）。恢复时后者优先 —
 * 加载器仅保留最新的快照 entry。
 */
export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) {
    return
  }
  await getProject().appendEntry({
    type: 'marble-origami-snapshot',
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

export async function hydrateRemoteSession(
  sessionId: string,
  ingressUrl: string,
): Promise<boolean> {
  switchSession(asSessionId(sessionId))

  const project = getProject()

  try {
    const remoteLogs = (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []

    // 确保项目目录和 session 文件存在
    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    const sessionFile = getTranscriptPathForSession(sessionId)

    // 用远程日志替换本地日志。writeFile 会截断，因此无需
    // unlink；空的 remoteLogs 数组会产生空文件。
    const content = remoteLogs.map((e) => `${jsonStringify(e)}\n`).join('')
    await writeFile(sessionFile, content, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(`Hydrated ${remoteLogs.length} entries from remote`)
    return remoteLogs.length > 0
  } catch (error) {
    logForDebugging(`Error hydrating session from remote: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_remote_session_fail')
    return false
  } finally {
    // 在 hydrate 远程 session 之后设置远程 ingress URL，
    // 确保在启用持久化之前始终已与远程 session 同步
    project.setRemoteIngressUrl(ingressUrl)
  }
}

/**
 * 从 CCR v2 内部事件 hydrate session 状态。
 * 通过已注册的读取器获取前台和子代理事件，
 * 从 payload 中提取 transcript entry，并写入本地 transcript 文件
 * （主文件 + 每个代理）。服务器处理压缩过滤 — 它返回从
 * 最新压缩边界开始的事件。
 */
export async function hydrateFromCCRv2InternalEvents(sessionId: string): Promise<boolean> {
  const startMs = Date.now()
  switchSession(asSessionId(sessionId))

  const project = getProject()
  const reader = project.getInternalEventReader()
  if (!reader) {
    logForDebugging('No internal event reader registered for CCR v2 resume')
    return false
  }

  try {
    // 获取前台事件
    const events = await reader()
    if (!events) {
      logForDebugging('Failed to read internal events for resume')
      logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_read_fail')
      return false
    }

    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    // 写入前台 transcript
    const sessionFile = getTranscriptPathForSession(sessionId)
    const fgContent = events.map((e) => `${jsonStringify(e.payload)}\n`).join('')
    await writeFile(sessionFile, fgContent, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(`Hydrated ${events.length} foreground entries from CCR v2 internal events`)

    // 获取并写入子代理事件
    let subagentEventCount = 0
    const subagentReader = project.getInternalSubagentEventReader()
    if (subagentReader) {
      const subagentEvents = await subagentReader()
      if (subagentEvents && subagentEvents.length > 0) {
        subagentEventCount = subagentEvents.length
        // 按 agent_id 分组
        const byAgent = new Map<string, Record<string, unknown>[]>()
        for (const e of subagentEvents) {
          const agentId = e.agent_id || ''
          if (!agentId) {
            continue
          }
          let list = byAgent.get(agentId)
          if (!list) {
            list = []
            byAgent.set(agentId, list)
          }
          list.push(e.payload)
        }

        // 将每个代理的 transcript 写入其自己的文件
        for (const [agentId, entries] of byAgent) {
          const agentFile = getAgentTranscriptPath(asAgentId(agentId))
          await mkdir(dirname(agentFile), { recursive: true, mode: 0o700 })
          const agentContent = entries.map((p) => `${jsonStringify(p)}\n`).join('')
          await writeFile(agentFile, agentContent, {
            encoding: 'utf8',
            mode: 0o600,
          })
        }

        logForDebugging(
          `Hydrated ${subagentEvents.length} subagent entries across ${byAgent.size} agents`,
        )
      }
    }

    logForDiagnosticsNoPII('info', 'hydrate_ccr_v2_completed', {
      duration_ms: Date.now() - startMs,
      event_count: events.length,
      subagent_event_count: subagentEventCount,
    })
    return events.length > 0
  } catch (error) {
    // 重新抛出 epoch 不匹配，以免 worker 与 gracefulShutdown 竞争
    if (error instanceof Error && error.message === 'CCRClient: Epoch mismatch (409)') {
      throw error
    }
    logForDebugging(`Error hydrating session from CCR v2: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_fail')
    return false
  }
}

/**
 * 向 session 文件追加一个 entry。如果父目录缺失则创建。
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
export function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
  const fs = getFsImplementation()
  const line = `${jsonStringify(entry)}\n`
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * 用于 reAppendSessionMetadata 外部写入检查的同步尾部读取。
 * 对已打开的 fd 执行 fstat（无额外路径查找）；读取与
 * readLiteMetadata 扫描相同的 LITE_READ_BUF_SIZE 窗口。
 * 任何错误时返回空字符串，使调用者回退到无条件行为。
 */
export function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset))
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync 可能抛出；吞掉以保持返回 '' 的契约
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  // 如果未提供 fullPath 则回退到计算的路径
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'custom-title',
    customTitle,
    sessionId,
  })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
  logEvent('zy_session_renamed', {
    source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 将 AI 生成的标题作为独立的 `ai-title` entry 持久化到 JSONL。
 *
 * 写入单独的 entry 类型（而非复用 `custom-title`）是承重的：
 * - 读取优先级：读取器优先使用 `customTitle` 字段而非 `aiTitle`，
 *   因此用户重命名始终优先，无论追加顺序。
 * - 恢复安全性：`loadTranscriptFile` 仅从 `custom-title` entry 填充
 *   `customTitles` Map，因此 `restoreSessionMetadata` 永不缓存 AI 标题，
 *   `reAppendSessionMetadata` 永不在 EOF 重新追加 AI 标题 — 避免了
 *   恢复时过时 AI 标题覆盖 session 中用户重命名的 bug。
 * - CAS 语义：VS Code 的 `onlyIfNoCustomTitle` 检查仅扫描
 *   `customTitle` 字段，因此 AI 可覆盖自己之前的 AI 标题但永不覆盖用户标题。
 * - 指标：AI 标题不触发 `zy_session_renamed`。
 *
 * 因为该 entry 永不被重新追加，一旦积累足够消息就会滚出 64KB
 * 尾部窗口。读取器（`readLiteMetadata`、`listSessionsImpl`、
 * VS Code `fetchSessions`）在这种情况下回退到扫描头部缓冲区的
 * `aiTitle`。头部和尾部读取都是有界的（各 64KB，通过
 * `extractLastJsonStringField`），永不全量扫描。
 *
 * 具有过时写入守卫的调用者（例如 VS Code 客户端）应优先
 * 向 SDK 控制请求传递 `persist: false`，并在守卫通过后通过
 * 自己的重命名路径持久化，以避免 AI 标题在飞行中的用户重命名
 * 之后落地的竞争。
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

/**
 * 为 `zy ps` 追加周期性任务摘要。与 ai-title 不同，这不会被
 * reAppendSessionMetadata 重新追加 — 它是代理当前正在做什么的滚动快照，
 * 因此过时是可以接受的；ps 从尾部读取最新的。
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'task-summary',
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // 如果未提供 fullPath 则回退到计算的路径
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'tag', tag, sessionId })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
  logEvent('zy_session_tagged', {})
}

/**
 * 将 session 链接到 GitHub pull request。
 * 存储 PR 编号、URL 和仓库，用于跟踪和导航。
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  // 为当前 session 缓存，以便 reAppendSessionMetadata 可在压缩后重写
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
  logEvent('zy_session_linked_to_pr', { prNumber })
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // 仅返回当前 session 的标签（我们唯一缓存的）
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(sessionId: SessionId): string | undefined {
  // 仅返回当前 session 的标题（我们唯一缓存的）
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * 恢复时将 session metadata 还原到内存缓存中。
 * 填充缓存使 metadata 可用于显示（例如代理横幅），
 * 并在 session 退出时通过 reAppendSessionMetadata 重新追加。
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const project = getProject()
  // ??= 使 --name（cacheSessionTitle）优先于恢复的 session 标题。
  // REPL.tsx 在调用前清除，因此 /resume 不受影响。
  if (meta.customTitle) {
    project.currentSessionTitle ??= meta.customTitle
  }
  if (meta.tag !== undefined) {
    project.currentSessionTag = meta.tag || undefined
  }
  if (meta.agentName) {
    project.currentSessionAgentName = meta.agentName
  }
  if (meta.agentColor) {
    project.currentSessionAgentColor = meta.agentColor
  }
  if (meta.agentSetting) {
    project.currentSessionAgentSetting = meta.agentSetting
  }
  if (meta.mode) {
    project.currentSessionMode = meta.mode
  }
  if (meta.worktreeSession !== undefined) {
    project.currentSessionWorktree = meta.worktreeSession
  }
  if (meta.prNumber !== undefined) {
    project.currentSessionPrNumber = meta.prNumber
  }
  if (meta.prUrl) {
    project.currentSessionPrUrl = meta.prUrl
  }
  if (meta.prRepository) {
    project.currentSessionPrRepository = meta.prRepository
  }
}

/**
 * 清除所有缓存的 session metadata（标题、标签、代理名称/颜色）。
 * 当 /clear 创建新 session 时调用，以防止前一个 session 的
 * 过时 metadata 泄漏到新 session 中。
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * 将缓存的 session metadata（自定义标题、标签）重新追加到 transcript
 * 文件末尾。在压缩后调用此函数以使 metadata 保持在 readLiteMetadata
 * 在渐进加载时读取的 16KB 尾部窗口内。否则，足够多的压缩后消息会将
 * metadata entry 推出窗口，导致 `--resume` 显示自动生成的 firstPrompt
 * 而非用户设置的 session 名称。
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'agent-name', agentName, sessionId })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
  logEvent('zy_agent_name_set', {
    source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function saveAgentColor(sessionId: UUID, agentColor: string, fullPath?: string) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'agent-color',
    agentColor,
    sessionId,
  })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
  logEvent('zy_agent_color_set', {})
}

/**
 * 缓存 session 代理设置。由 materializeSessionFile 在首条用户消息时写入磁盘，
 * 并在退出时由 reAppendSessionMetadata 重新标记。
 * 此处仅缓存以避免在启动时创建仅含 metadata 的 session 文件。
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/**
 * 缓存启动时设置的 session 标题（--name）。由 materializeSessionFile
 * 在首条用户消息时写入磁盘。此处仅缓存，以在 session ID 确定之前
 * 不创建孤立的仅含 metadata 的文件。
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * 缓存 session 模式。由 materializeSessionFile 在首条用户消息时写入磁盘，
 * 并在退出时由 reAppendSessionMetadata 重新标记。
 * 此处仅缓存以避免在启动时创建仅含 metadata 的 session 文件。
 */
export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

/**
 * 记录 session 的 worktree 状态用于 --resume。由 materializeSessionFile
 * 在首条用户消息时写入磁盘，并在退出时由 reAppendSessionMetadata 重新标记。
 * 退出 worktree 时传入 null，以便 --resume 知道不要 cd 回去。
 */
export function saveWorktreeState(worktreeSession: PersistedWorktreeSession | null): void {
  // 剥离调用者可能通过完整 WorktreeSession 对象传递的临时字段
  // （creationDurationMs, usedSparsePaths）— TypeScript 结构类型允许这样做，
  // 但我们不希望它们被序列化到 transcript 中。
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // 当文件已存在时急切写入（session 中进入/退出）。
  // 对于 --worktree 启动，sessionFile 为 null — materializeSessionFile
  // 将在首条消息时通过 reAppendSessionMetadata 写入。
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
}
