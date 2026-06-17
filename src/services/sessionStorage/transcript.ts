// transcript 写路径 + hydrate：record* / flush / hydrateRemoteSession / hydrateFromCCRv2InternalEvents。
// 文件写入原子助手 appendEntryToFile / readFileTailSync。

import type { UUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getOriginalCwd, getSessionId, switchSession } from '../../bootstrap/state.js'
import { type AgentId, asAgentId, asSessionId } from '../../types/ids.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import type { QueueOperationMessage } from '../../types/messageQueueTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { LITE_READ_BUF_SIZE } from '../../utils/sessionStoragePortable.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import * as sessionIngress from '../api/sessionIngress.js'
import { cleanMessagesForLogging, getSessionMessages } from './logLoading.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from './paths.js'
import { isChainParticipant } from './predicates.js'
import { getProject } from './project.js'

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
