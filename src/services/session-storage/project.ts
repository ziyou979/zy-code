// Project singleton：transcript 文件状态、内存缓冲、flush 调度、session metadata 缓存。
// 所有 record*/save* 通过 getProject() 访问其状态。

// 临时回环：appendEntryToFile / readFileTailSync 仍在 sessionStorage.ts。
// 一旦 transcript.ts 抽出，可改为从那里 import。

import type { UUID } from 'node:crypto'
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../../bootstrap/runtime/runtimeContext.js'
import { type AgentId, asAgentId } from '../../types/ids.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import {
  type ContentReplacementEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type PersistedWorktreeSession,
  type TranscriptMessage,
} from '../../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { QueueOperationMessage } from '../../types/messageQueueTypes.js'
import { registerCleanup } from '../cleanup/cleanupRegistry.js'
import { getCwd } from '../environment/cwd.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { isFsInaccessible } from '../../utils/errors.js'
import type { FileHistorySnapshot } from '../file-persistence/fileHistory.js'
import { formatFileSize } from '../../utils/format.js'
import { getBranch } from '../../services/infra/git.js'
import { gracefulShutdownSync, isShuttingDown } from '../../bootstrap/lifecycle/gracefulShutdown.js'
import { logError } from '../../services/infra/log.js'
import { isCompactBoundaryMessage } from '../messages/predicates.js'
import { extractLastJsonStringField, LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'
import { getInitialSettings } from '../settings/settings.js'
import { jsonParse, jsonStringify } from '../../services/infra/slowOperations.js'
import type { ContentReplacementRecord } from '../../services/mcp/toolResultStorage.js'
import * as sessionIngress from '../api/sessionIngress.js'
import { getFirstMeaningfulUserMessageTextContent } from './chain.js'
import { getEntrypoint, getNodeEnv, getUserType } from './env.js'
import { getSessionMessages, MAX_TOMBSTONE_REWRITE_BYTES } from './logLoading.js'
import { getAgentTranscriptPath, getTranscriptPath, getTranscriptPathForSession } from './paths.js'
import { isChainParticipant, isTranscriptMessage } from './predicates.js'
import { updateSessionSidecar } from './sessionSidecar.js'
import { readFileTailSync } from './transcript.js'

// 在模块层级缓存 MACRO.VERSION，用于规避 bun --define 在异步上下文中的 bug
// 参见: https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

let project: Project | null = null

let cleanupRegistered = false

export function getProject(): Project {
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
  // 把会话级可变元数据落盘到 sidecar(<sessionId>.meta.json)。
  // 旧实现把这些字段反复追加到 JSONL 末尾以待 64KB 尾读取;现在 sidecar 原子整体
  // 覆写,既根除重复也无需"贴 EOF"。仍先吸收外部 SDK(VS Code)写到 JSONL 的
  // title/tag,再合并写 sidecar(merge 保留 saveAiGeneratedTitle/saveTaskSummary
  // 直接写入的 aiTitle/taskSummary)。
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) {
      return
    }
    const sessionId = getSessionId() as UUID
    if (!sessionId) {
      return
    }
    this.refreshFromExternalWriters(skipTitleRefresh)
    this.flushSidecar()
  }

  // 吸收外部 SDK 直接写到 JSONL 尾部的 custom-title / tag(VS Code 等仍走 JSONL)。
  private refreshFromExternalWriters(skipTitleRefresh: boolean): void {
    if (!this.sessionFile) {
      return
    }
    const tail = readFileTailSync(this.sessionFile)
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast((l) => l.startsWith('{"type":"custom-title"'))
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast((l) => l.startsWith('{"type":"tag"'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }
  }

  private flushSidecar(): void {
    if (!this.sessionFile) {
      return
    }
    const prLink =
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
        ? {
            prNumber: this.currentSessionPrNumber,
            prUrl: this.currentSessionPrUrl,
            prRepository: this.currentSessionPrRepository,
            timestamp: new Date().toISOString(),
          }
        : undefined
    // updateSessionSidecar 跳过 undefined(不清除已有)、保留显式 null(worktree 已退出)。
    updateSessionSidecar(this.sessionFile, {
      customTitle: this.currentSessionTitle,
      tag: this.currentSessionTag,
      lastPrompt: this.currentSessionLastPrompt,
      agentName: this.currentSessionAgentName,
      agentColor: this.currentSessionAgentColor,
      agentSetting: this.currentSessionAgentSetting,
      mode: this.currentSessionMode,
      worktreeState: this.currentSessionWorktree,
      prLink,
    })
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
