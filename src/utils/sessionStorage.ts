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

// 在模块层级缓存 MACRO.VERSION，用于规避 bun --define 在异步上下文中的 bug
// 参见: https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

let project: Project | null = null
let cleanupRegistered = false

function getProject(): Project {
  if (!project) {
    project = new Project()

    // 注册 flush 为清理处理器（仅一次）
    if (!cleanupRegistered) {
      registerCleanup(async () => {
        // 先 flush 队列中的写入，然后重新追加 session metadata
        // （customTitle、tag），使它们始终出现在最后 64KB 尾部窗口中。
        // readLiteMetadata 仅读取尾部来提取这些字段 — 如果在 /rename
        // 之后追加了足够多的消息，custom-title entry 会被推出窗口，
        // --resume 则显示自动生成的 firstPrompt。
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
          // 尽力而为 — 不让 metadata 重新追加导致清理崩溃
        }
      })
      cleanupRegistered = true
    }
  }
  return project
}

/**
 * 重置 Project 单例的 flush 状态，用于测试。
 * 确保测试之间不会因共享计数器状态而相互干扰。
 */
export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

/**
 * 重置整个 Project 单例，用于测试。
 * 确保使用不同 ZY_CONFIG_DIR 值的测试不会共享过时的 sessionFile 路径。
 */
export function resetProjectForTesting(): void {
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

/**
 * 注册 CCR v2 内部事件写入器，用于 transcript 持久化。
 * 设置后，transcript 消息将作为内部 worker 事件写入，
 * 而非通过 v1 Session Ingress。
 */
export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

/**
 * 注册 CCR v2 内部事件读取器，用于 session 恢复。
 * 设置后，hydrateFromCCRv2InternalEvents() 可获取前台和
 * 子代理内部事件，以在重连时重建对话状态。
 */
export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

/**
 * 为当前 Project 设置远程 ingress URL，用于测试。
 * 模拟 hydrateRemoteSession 在生产环境中的行为。
 */
export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

const REMOTE_FLUSH_INTERVAL_MS = 10

class Project {
  // 仅当前 session 的最小缓存（非所有 session）
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  // 三态：undefined = 从未触碰（不写入），null = 已退出 worktree，
  // object = 当前在 worktree 中。reAppendSessionMetadata 写入 null 以便
  // --resume 知道 session 已退出（而非在内部崩溃）。
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  // sessionFile 为 null 时缓冲的 entry。由 materializeSessionFile
  // 在首条 user/assistant 消息时 flush — 防止产生仅含 metadata 的 session 文件。
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  // 按文件的写入队列。每个 entry 携带一个 resolve 回调，
  // enqueueWrite 的调用者可以选择性地 await 自己的特定写入。
  private writeQueues = new Map<string, Array<{ entry: Entry; resolve: () => void }>>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024

  /** @internal 重置 flush/队列状态，用于测试。 */
  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }
    this.flushTimer = null
    this.activeDrain = null
    this.writeQueues = new Map()
  }

  private incrementPendingWrites(): void {
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      // 解析所有等待中的 flush promise
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    return new Promise<void>((resolve) => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      queue.push({ entry, resolve })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      this.activeDrain = this.drainWriteQueue()
      await this.activeDrain
      this.activeDrain = null
      // 如果在 drain 期间有更多项到达，重新调度
      if (this.writeQueues.size > 0) {
        this.scheduleDrain()
      }
    }, this.FLUSH_INTERVAL_MS)
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      // 目录可能不存在 — 某些类 NFS 文件系统会返回
      // 意外的错误码，因此不按错误码区分。
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await fsAppendFile(filePath, data, { mode: 0o600 })
    }
  }

  private async drainWriteQueue(): Promise<void> {
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      let content = ''
      const resolvers: Array<() => void> = []

      for (const { entry, resolve } of batch) {
        const line = `${jsonStringify(entry)}\n`

        if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
          // 在开始新 chunk 之前 flush 当前 chunk 并解析其条目
          await this.appendToFile(filePath, content)
          for (const r of resolvers) {
            r()
          }
          resolvers.length = 0
          content = ''
        }

        content += line
        resolvers.push(resolve)
      }

      if (content.length > 0) {
        await this.appendToFile(filePath, content)
        for (const r of resolvers) {
          r()
        }
      }
    }

    // 清理空队列
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.pendingEntries = []
  }

  /**
   * 将缓存的 session metadata 重新追加到 transcript 文件末尾。
   * 确保 metadata 保持在 readLiteMetadata 在渐进加载时读取的尾部窗口内。
   *
   * 从两个上下文调用，具有不同的文件排序含义：
   * - 压缩期间（compact.ts, reactiveCompact.ts）：在 boundary 标记
   *   发出之前写入 metadata - 这些 entry 最终位于 boundary 之前，
   *   由 scanPreBoundaryMetadata 恢复。
   * - session 退出时（清理处理器）：在所有 boundary 之后写入 metadata
   *   到 EOF - 这使 loadTranscriptFile 的 pre-compact 跳过能在不
   *   进行前向扫描的情况下找到 metadata。
   *
   * SDK 可变字段（custom-title, tag）的外部写入安全性：
   * 在重新追加之前，从尾部扫描窗口刷新缓存。如果外部进程
   * （SDK renameSession/tagSession）写入了更新的值，我们过时的
   * 缓存会吸收它，下面的重新追加会持久化它 — 而非过时的 CLI 值。
   * 如果尾部没有 entry（被驱逐或 SDK 从未写入），缓存是唯一的
   * 真实来源，按原样重新追加。
   *
   * 重新追加是无条件的（即使值已在尾部中）：压缩期间，距 EOF
   * 40KB 的标题在当前尾部窗口内，但一旦压缩后 session 增长就会
   * 超出窗口。跳过重新追加会使此调用失去意义。SDK 无法触及的
   * 字段（last-prompt, agent-*, mode, pr-link）无外部写入问题 —
   * 它们的缓存具有权威性。
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) {
      return
    }
    const sessionId = getSessionId() as UUID
    if (!sessionId) {
      return
    }

    // 一次同步尾部读取以刷新 SDK 可变字段。使用与 readLiteMetadata
    // 相同的 LITE_READ_BUF_SIZE 窗口。失败时返回空字符串 →
    // extract 返回 null → 缓存是唯一真实来源。
    const tail = readFileTailSync(this.sessionFile)

    // 将任何更新的 SDK 写入的 title/tag 吸收到我们的缓存中。如果 SDK
    // 在我们打开 session 时进行了写入，缓存是过时的 — 尾部值具有
    // 权威性。如果尾部没有内容（被驱逐或从未外部写入），缓存保持不变。
    //
    // 使用 startsWith 过滤以仅匹配顶层 JSONL entry（第 0 列），
    // 而非出现在嵌套 tool_use 输入中恰好被 JSON 序列化到消息中的
    // "type":"tag"。
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast((l) => l.startsWith('{"type":"custom-title"'))
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        // `!== undefined` 区分无匹配和空字符串匹配。
        // renameSession 拒绝空标题，但 CLI 采用防御性策略：
        // 外部写入 customTitle:"" 应清除缓存，使下面的重新追加
        // 跳过它（而非复活一个过时的标题）。
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast((l) => l.startsWith('{"type":"tag"'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      // 同上：tagSession(id, null) 写入 `tag:""` 来清除。
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }

    // lastPrompt 被重新追加，使 readLiteMetadata 可以显示用户最近在做什么。
    // 先写入它，使 customTitle/tag 等更靠近 EOF
    // （它们是尾部读取中更关键的字段）。
    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: 'last-prompt',
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    // 无条件：缓存已从上面的尾部刷新；重新追加使 entry 保持在 EOF，
    // 这样压缩推送的内容不会驱逐它。
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: 'custom-title',
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: 'tag',
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-name',
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-color',
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-setting',
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: 'mode',
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: 'worktree-state',
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: 'pr-link',
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    // 取消待处理的定时器
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // 等待进行中的 drain 完成
    if (this.activeDrain) {
      await this.activeDrain
    }
    // 排空队列中剩余的内容
    await this.drainWriteQueue()

    // 等待非队列的受跟踪操作（例如 removeMessageByUuid）
    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * 通过 UUID 从 transcript 中删除一条消息。
   * 用于标记流式传输失败产生的孤立消息为 tombstone。
   *
   * 目标几乎总是最近追加的 entry，因此我们只读取尾部，
   * 定位该行，并通过定位写入 + 截断将其移除，
   * 而非重写整个文件。
   */
  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.trackWrite(async () => {
      if (this.sessionFile === null) {
        return
      }
      try {
        let fileSize = 0
        const fh = await fsOpen(this.sessionFile, 'r+')
        try {
          const { size } = await fh.stat()
          fileSize = size
          if (size === 0) {
            return
          }

          const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
          const tailStart = size - chunkLen
          const buf = Buffer.allocUnsafe(chunkLen)
          const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
          const tail = buf.subarray(0, bytesRead)

          // entry 通过 JSON.stringify 序列化（无键值空白）。搜索完整的
          // `"uuid":"..."` 模式，而非裸 UUID，以避免匹配到子 entry 的
          // `parentUuid` 中相同的值。UUID 是纯 ASCII，因此字节级
          // 搜索是正确的。
          const needle = `"uuid":"${targetUuid}"`
          const matchIdx = tail.lastIndexOf(needle)

          if (matchIdx >= 0) {
            // 0x0a 不会出现在 UTF-8 多字节序列中，因此即使 chunk
            // 从字符中间开始，字节扫描行边界也是安全的。
            const prevNl = tail.lastIndexOf(0x0a, matchIdx)
            // 如果前面的换行符在 chunk 之外且我们不是从文件开头读取的，
            // 则该行比窗口更长 — 回退到慢路径。
            if (prevNl >= 0 || tailStart === 0) {
              const lineStart = prevNl + 1 // 0 when prevNl === -1
              const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
              const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

              const absLineStart = tailStart + lineStart
              const afterLen = bytesRead - lineEnd
              // 先截断，然后重新追加尾部行。在常见情况下（目标是最后
              // 一个 entry）afterLen 为 0，这只是一次 ftruncate。
              await fh.truncate(absLineStart)
              if (afterLen > 0) {
                await fh.write(tail, lineEnd, afterLen, absLineStart)
              }
              return
            }
          }
        } finally {
          await fh.close()
        }

        // 慢路径：目标不在最后 64KB 中。罕见 — 需要在写入和 tombstone
        // 之间存在许多大 entry。
        if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
          logForDebugging(
            `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
            { level: 'warn' },
          )
          return
        }
        const content = await readFile(this.sessionFile, { encoding: 'utf-8' })
        const lines = content.split('\n').filter((line: string) => {
          if (!line.trim()) {
            return true
          }
          try {
            const entry = jsonParse(line)
            return entry.uuid !== targetUuid
          } catch {
            return true // 保留格式错误的行
          }
        })
        await writeFile(this.sessionFile, lines.join('\n'), {
          encoding: 'utf8',
        })
      } catch {
        // 静默忽略错误 — 文件可能尚未存在
      }
    })
  }

  /**
   * 当 test 环境 / cleanupPeriodDays=0 / --no-session-persistence /
   * ZY_CODE_SKIP_PROMPT_HISTORY 应抑制所有 transcript 写入时返回 true。
   * 作为 appendEntry 和 materializeSessionFile 的共享守卫，使两者
   * 一致地跳过。该环境变量由 tmuxSocket.ts 设置，以防止 Tungsten
   * 启动的测试 session 污染用户的 --resume 列表。
   */
  private shouldSkipPersistence(): boolean {
    const allowTestPersistence = isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)
    return (
      (getNodeEnv() === 'test' && !allowTestPersistence) ||
      getInitialSettings()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.ZY_CODE_SKIP_PROMPT_HISTORY)
    )
  }

  /**
   * 创建 session 文件，写入缓存的启动 metadata，并 flush 缓冲的 entry。
   * 在首条 user/assistant 消息时调用。
   */
  private async materializeSessionFile(): Promise<void> {
    // 此处也需守卫 — reAppendSessionMetadata 通过 appendEntryToFile
    // （而非 appendEntry）写入，因此会绕过逐 entry 的持久化检查，
    // 尽管设置了 --no-session-persistence 仍会创建仅含 metadata 的文件。
    if (this.shouldSkipPersistence()) {
      return
    }
    this.ensureCurrentSessionFile()
    // mode/agentSetting 在物化之前仅存于缓存中；现在写入它们。
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
  ) {
    return this.trackWrite(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null

      // 首条 user/assistant 消息触发 session 文件的物化。
      // 仅 hook progress/attachment 消息保持缓冲。
      if (
        this.sessionFile === null &&
        messages.some((m) => m.type === 'user' || m.type === 'assistant')
      ) {
        await this.materializeSessionFile()
      }

      // 为此消息链获取一次当前 git branch
      let gitBranch: string | undefined
      try {
        gitBranch = await getBranch()
      } catch {
        // 不在 git 仓库中或 git 命令失败
        gitBranch = undefined
      }

      // 获取此 session 的 slug（如果存在）（用于 plan 文件等）
      const sessionId = getSessionId()
      const slug = getPlanSlugCache().get(sessionId)

      for (const message of messages) {
        const isCompactBoundary = isCompactBoundaryMessage(message)

        // 对于 tool_result 消息，使用消息中的 assistant 消息 UUID
        // （如果可用，在创建时设置），否则回退到顺序父级
        let effectiveParentUuid = parentUuid
        if (
          message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId: message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          // session 标记字段必须在展开之后。在 --fork-session 和 --resume 时，
          // 消息以 SerializedMessage 到达（携带源 sessionId/cwd 等，因为
          // removeExtraFields 只剥离 parentUuid 和 isSidechain）。如果 sessionId
          // 未重新标记，FRESH.jsonl 中的消息标记为 sessionId=A，但
          // content-replacement entry 标记为 sessionId=FRESH（来自
          // insertContentReplacement），loadFullLog 以 sessionId 为键的
          // contentReplacements 查找会遗漏 → 替换记录丢失 → FROZEN 误分类。
          userType: getUserType(),
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid as UUID
        }
      }

      // 缓存此轮的用户 prompt 用于 reAppendSessionMetadata —
      // --resume 选择器显示用户最近在做什么。
      // 设计上每轮都会覆盖。
      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, ' ').trim()
          this.currentSessionLastPrompt = flat.length > 200 ? `${flat.slice(0, 200).trim()}…` : flat
        }
      }
    })
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: 'file-history-snapshot',
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(replacements: ContentReplacementRecord[], agentId?: AgentId) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: 'content-replacement',
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      // 缓冲直到 materializeSessionFile 运行（首条 user/assistant 消息）。
      if (this.sessionFile === null) {
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(new Error(`appendEntry: session file not found for other session ${sessionId}`))
        return
      }
      sessionFile = existing
    }

    // 仅在需要时加载当前 session 消息
    if (entry.type === 'summary') {
      // 摘要总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'custom-title') {
      // 自定义标题总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'ai-title') {
      // AI 标题总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'last-prompt') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'task-summary') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'tag') {
      // 标签总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-name') {
      // 代理名称总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-color') {
      // 代理颜色总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-setting') {
      // 代理设置总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'pr-link') {
      // PR 链接总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'file-history-snapshot') {
      // 文件历史快照总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'attribution-snapshot') {
      // 归因快照总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'speculation-accept') {
      // speculation accept entry 总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'mode') {
      // 模式 entry 总是可以追加
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'worktree-state') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'content-replacement') {
      // content replacement 记录总是可以追加。子代理记录
      // 写入 sidechain 文件（用于 AgentTool 恢复）；主线程
      // 记录写入 session 文件（用于 /resume）。
      const targetFile = entry.agentId ? getAgentTranscriptPath(entry.agentId) : sessionFile
      void this.enqueueWrite(targetFile, entry)
    } else if (entry.type === 'marble-origami-commit') {
      // 总是追加。提交顺序对恢复很重要（后面的提交可能引用
      // 前面提交的摘要消息），因此必须按接收顺序写入并顺序读回。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'marble-origami-snapshot') {
      // 总是追加。恢复时后者优先 — 后面的 entry 取代前面的。
      void this.enqueueWrite(sessionFile, entry)
    } else {
      const messageSet = await getSessionMessages(sessionId)
      if (entry.type === 'queue-operation') {
        // 队列操作总是追加到 session 文件
        void this.enqueueWrite(sessionFile, entry)
      } else {
        // 此时 entry 必须是 TranscriptMessage（user/assistant/attachment/system）
        // 所有其他 entry 类型已在上面处理
        const isAgentSidechain = entry.isSidechain && entry.agentId !== undefined
        const targetFile = isAgentSidechain
          ? getAgentTranscriptPath(asAgentId(entry.agentId!))
          : sessionFile

        // 对于消息 entry，检查 UUID 是否已存在于当前 session 中。
        // 跳过代理 sidechain 本地写入的去重 — 它们写入单独的文件，
        // 且 fork 继承的父消息与主 session transcript 共享 UUID。
        // 对主 session 的集合进行去重会丢弃它们，使持久化的 sidechain
        // transcript 不完整（fork 恢复加载 10KB 文件而非完整的 85KB
        // 继承上下文）。
        //
        // sidechain 绕过仅适用于本地文件写入 — 远程持久化
        // （session-ingress）每个 sessionId 使用单一 Last-Uuid 链，
        // 因此重新 POST 一个已有的 UUID 会 409，最终耗尽重试 →
        // gracefulShutdownSync(1)。参见 inc-4718。
        const isNewUuid = !messageSet.has(entry.uuid)
        if (isAgentSidechain || isNewUuid) {
          // 入队写入 — appendToFile 通过创建目录处理 ENOENT
          void this.enqueueWrite(targetFile, entry)

          if (!isAgentSidechain) {
            // messageSet 以主文件为权威。sidechain entry 写入单独的代理文件 —
            // 在此添加它们的 UUID 会导致 recordTranscript 在主线程上跳过它们
            // （约第 1270 行），消息永远不会写入主 session 文件。下一条主线程
            // 消息的 parentUuid 会链接到一个仅存在于代理文件中的 UUID，
            // --resume 的 buildConversationChain 在悬挂引用处终止。
            // 远程也有相同约束（上面的 inc-4718）：sidechain 持久化了
            // 主线程尚未写入的 UUID → 主线程写入时 409。
            messageSet.add(entry.uuid)

            if (isTranscriptMessage(entry)) {
              await this.persistToRemote(sessionId, entry)
            }
          }
        }
      }
    }
  }

  /**
   * 加载 sessionFile 变量。
   * 在写入之前无需创建 session 文件。
   */
  private ensureCurrentSessionFile(): string {
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }

    return this.sessionFile
  }

  /**
   * 如果 session 文件存在则返回其路径，否则返回 null。
   * 用于写入当前 session 之外的其他 session。
   * 缓存肯定结果，每个 session 只 stat 一次。
   */
  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(sessionId: UUID): Promise<string | null> {
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) {
      return cached
    }

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) {
        return null
      }
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    if (isShuttingDown()) {
      return
    }

    // CCR v2 路径：作为内部 worker 事件写入
    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter('transcript', entry as unknown as Record<string, unknown>, {
          ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
          ...(entry.agentId && { agentId: entry.agentId }),
        })
      } catch {
        logEvent('zy_session_persistence_failed', {})
        logForDebugging('Failed to write transcript as internal event')
      }
      return
    }

    // v1 Session Ingress 路径
    if (!isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE) || !this.remoteIngressUrl) {
      return
    }

    const success = await sessionIngress.appendSessionLog(sessionId, entry, this.remoteIngressUrl)

    if (!success) {
      logEvent('zy_session_persistence_failed', {})
      gracefulShutdownSync(1, 'other')
    }
  }

  setRemoteIngressUrl(url: string): void {
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      // 如果使用 CCR，消息延迟不超过 10ms。
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.internalEventWriter = writer
    logForDebugging('CCR v2 internal event writer registered for transcript persistence')
    // 为 CCR v2 使用快速 flush 间隔
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.internalEventReader = reader
    logForDebugging('CCR v2 internal event reader registered for session resume')
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.internalSubagentEventReader = reader
    logForDebugging('CCR v2 subagent event reader registered for session resume')
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

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
function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
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
function readFileTailSync(fullPath: string): string {
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
