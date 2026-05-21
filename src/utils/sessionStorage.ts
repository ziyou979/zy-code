// @ts-nocheck
import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
// readFileTailSync 所需的同步 fs 原语 — 与上面的 fs/promises 导入分开。
// 按 CLAUDE.md 风格使用具名导入（非通配符）；与异步后缀命名无冲突。
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

// 在模块层级缓存 MACRO.VERSION，用于规避 bun --define 在异步上下文中的 bug
// 参见: https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

// 在每个调用点使用 getOriginalCwd()，而不是在模块加载时捕获。
// 在 import 时调用 getCwd() 可能先于 bootstrap 通过 realpathSync 解析符号链接，
// 导致产生与 bootstrap 完成后 getOriginalCwd() 返回的不同的 sanitized 项目目录。
// 这种分裂导致在某路径下保存的 session 在通过另一路径加载时不可见。

/**
 * 预编译的正则表达式，用于在提取首条提示词时跳过无意义的消息。
 * 匹配以小写 XML 标签开头的内容（IDE 上下文、hook 输出、任务通知、
 * 频道消息等）或合成的中断标记。与 sessionStoragePortable.ts 保持同步 —
 * 通用模式避免了随着新通知类型发布而不断增长的白名单。
 */
// 50MB — 防止 tombstone 慢路径（读取并重写整个 session 文件）时发生 OOM。
// session 文件可增长到数 GB（inc-3930）。
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * 类型守卫，用于检查一个 entry 是否为 transcript 消息。
 * transcript 消息包括 user、assistant、attachment 和 system 消息。
 * 重要：这是判定什么构成 transcript 消息的唯一权威来源。
 * loadTranscriptFile() 使用此函数决定哪些消息加载到对话链中。
 *
 * progress 消息不是 transcript 消息。它们是临时的 UI 状态，
 * 不应持久化到 JSONL 或参与 parentUuid 链。将它们包含在内会导致
 * 链分叉，使真实对话消息在恢复时成为孤儿（参见 #14373, #23537）。
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

/**
 * 参与 parentUuid 链的 entry。在写入路径（insertMessageChain、useLogMessages）中
 * 用于在分配 parentUuid 时跳过 progress。旧的 transcript 中已在链里的 progress
 * 由 loadTranscriptFile 中的 progressBridge 重写处理。
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * PR #24099 之前写入的 transcript 中的 progress entry。它们不再属于
 * Entry 类型联合，但仍以包含 uuid 和 parentUuid 字段的形式存在于磁盘上。
 * loadTranscriptFile 会在它们之间桥接链。
 */
function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * 高频工具进度 tick（Sleep 为 1次/秒，Bash 为每 chunk 一次）。
 * 仅用于 UI：不发送到 API，工具完成后不渲染。REPL.tsx 用它来
 * 原地替换而非追加，loadTranscriptFile 用它来跳过旧 transcript 中的遗留 entry。
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  ...(feature('PROACTIVE') || feature('KAIROS') ? (['sleep_progress'] as const) : []),
])
export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function getProjectsDir(): string {
  return join(getZyConfigHomeDir(), 'projects')
}

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  // 请求当前 session 的 transcript 时，遵循 sessionProjectDir，
  // 与 getTranscriptPath() 保持一致。否则 hook 会基于 originalCwd 计算
  // transcript_path，而实际文件被写入 sessionProjectDir（由
  // switchActiveSession 在 resume/branch 时设置）— 目录不同，hook 看到
  // MISSING (gh-30217)。CC-34 正是为了防止这种漂移而将 sessionId +
  // sessionProjectDir 做成原子操作；只是这个函数之前没更新为读取两者。
  //
  // 对于其他 session ID，我们只能通过 originalCwd 猜测 — 我们不维护
  // sessionId→projectDir 的映射。需要特定其他 session 路径的调用者应
  // 显式传入 fullPath（大多数 save* 函数已支持此参数）。
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// 50 MB — session JSONL 可增长到数 GB（inc-3930）。读取原始 transcript 的
// 调用者必须在超过此阈值时中止以避免 OOM。
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// agentId → 子目录的内存映射，用于对相关子代理 transcript 进行分组
// （例如 workflow 运行写入 subagents/workflows/<runId>/）。
// 在代理运行之前填充；由 getAgentTranscriptPath 查询。
const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  // 与 getTranscriptPathForSession 相同的 sessionProjectDir 一致性 —
  // 子代理 transcript 位于 session 目录下，因此如果 session transcript
  // 在 sessionProjectDir，子代理 transcript 也在那里。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}

function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

export type AgentMetadata = {
  agentType: string
  /** 代理以 isolation: "worktree" 方式启动时的 worktree 路径 */
  worktreePath?: string
  /** 来自 AgentTool 输入的原始任务描述。持久化后恢复的代理通知可以
   * 显示原始描述而非占位符。可选 — 旧的 metadata 文件可能缺少此字段。 */
  description?: string
}

/**
 * 持久化用于启动子代理的 agentType。恢复时读取以便在
 * subagent_type 被省略时正确路由 — 否则恢复 fork 会静默降级为
 * 通用模式（4KB system prompt，无继承历史）。使用 sidecar 文件
 * 避免 JSONL schema 变更。
 *
 * 当代理以 worktree 隔离方式启动时也会存储 worktreePath，
 * 使恢复时可以还原正确的 cwd。
 */
export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    throw e
  }
}

export type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  /** CCR session ID — 恢复时用于从 Sessions API 获取实时状态。 */
  sessionId: string
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}

function getRemoteAgentsDir(): string {
  // 与 getAgentTranscriptPath 相同的 sessionProjectDir 回退 — 是项目目录
  // （包含 .jsonl 的目录），而非 session 目录，因此需拼接 sessionId。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'remote-agents')
}

function getRemoteAgentMetadataPath(taskId: string): string {
  return join(getRemoteAgentsDir(), `remote-agent-${taskId}.meta.json`)
}

/**
 * 持久化远程代理任务的 metadata，以便 session 恢复时可以还原。
 * 按任务的 sidecar 文件（与 subagents/ 同级目录）在
 * hydrateSessionFromRemote 的 .jsonl 清除中幸存；状态总是从
 * CCR 重新获取 — 只有身份信息在本地持久化。
 */
export async function writeRemoteAgentMetadata(
  taskId: string,
  metadata: RemoteAgentMetadata,
): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readRemoteAgentMetadata(taskId: string): Promise<RemoteAgentMetadata | null> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as RemoteAgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    throw e
  }
}

export async function deleteRemoteAgentMetadata(taskId: string): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    await unlink(path)
  } catch (e) {
    if (isFsInaccessible(e)) {
      return
    }
    throw e
  }
}

/**
 * 扫描 remote-agents/ 目录中所有已持久化的 metadata 文件。
 * 由 restoreRemoteAgentTasks 使用，以重新连接仍在运行的 CCR session。
 */
export async function listRemoteAgentMetadata(): Promise<RemoteAgentMetadata[]> {
  const dir = getRemoteAgentsDir()
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) {
      return []
    }
    throw e
  }
  const results: RemoteAgentMetadata[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) {
      continue
    }
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8')
      results.push(JSON.parse(raw) as RemoteAgentMetadata)
    } catch (e) {
      // 跳过不可读或损坏的文件 — 崩溃时 fire-and-forget 写入产生的
      // 部分写入不应导致整个恢复失败。
      logForDebugging(`listRemoteAgentMetadata: skipping ${entry.name}: ${String(e)}`)
    }
  }
  return results
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

// 导出用于测试
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

// 导出用于测试
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

function getEntrypoint(): string | undefined {
  return process.env.ZY_CODE_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

// 已记忆化：通过 hooks.ts createBaseHookInput 每轮调用 12+ 次
// （PostToolUse 路径，每轮 5 次）+ 各种 save* 函数。输入是 cwd
// 字符串；homedir/env/regex 在整个 session 中不变，因此对给定输入
// 结果稳定。Worktree 切换只改变 key — 无需清除缓存。
export let getProjectDir
getProjectDir = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

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
          parentUuid = message.uuid
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

function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // 存储一个合理长度的版本用于显示时截断
    // 实际截断将在显示时根据终端宽度应用
    if (result.length > 200) {
      result = `${result.slice(0, 200).trim()}…`
    }

    return result
  }

  return 'No prompt'
}

/**
 * 获取最后一条已处理的用户消息（即在任何非用户消息出现之前）。
 * 用于确定 session 是否有有效的用户交互。
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) {
      continue
    }
    // 跳过压缩摘要消息 - 它们不应被视为首条 prompt
    if ('isCompactSummary' in msg && msg.isCompactSummary) {
      continue
    }

    const content = msg.message?.content
    if (!content) {
      continue
    }

    // 收集所有文本值。对于数组内容（在 VS Code 中很常见，其中
    // IDE metadata 标签在用户实际 prompt 之前），遍历所有文本块，
    // 以免遗漏隐藏在 <ide_selection>/<ide_opened_file> 块后面的
    // 真实 prompt。
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) {
        continue
      }

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // 如果是内置命令，它不太可能提供有意义的上下文（例如 `/model sonnet`）
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // 否则，对于自定义命令，仅在有参数时保留（例如 `/review reticulate splines`）
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          // 返回清洁格式化的命令而非原始 XML
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // 以 ! 前缀格式化 bash 输入（如用户输入的那样）。在通用 XML 跳过
      // 之前检查，使 bash 模式 session 获得有意义的标题。
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // 跳过无意义的消息（本地命令输出、hook 输出、
      // 自主 tick prompt、任务通知、纯 IDE metadata 标签）
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(transcript: TranscriptMessage[]): SerializedMessage[] {
  return transcript.map((m) => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * 压缩后将保留段重新拼接回链中。
 *
 * 保留的消息在 JSONL 中保持其原始的压缩前 parentUuid
 * （recordTranscript 去重跳过了它们 — 无法重写）。
 * 内部链（keep[i+1]→keep[i]）完整；只有端点需要修补：
 * head→anchor，以及 anchor 的其他子节点→tail。anchor 在
 * 后缀保留时是最后一个摘要，在前缀保留时是 boundary 本身。
 *
 * 只有最后一个 seg-boundary 被重新链接 — 更早的 seg 已被
 * 摘要进其中。绝对最后 boundary 之前的所有内容（preservedUuids
 * 除外）都被删除，这处理了所有多 boundary 形状而无需特殊处理。
 *
 * 原地修改 Map。
 */
function applyPreservedSegmentRelinks(messages: Map<UUID, TranscriptMessage>): void {
  type Seg = NonNullable<SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']>

  // 找到绝对最后的 boundary 和最后的 seg-boundary（可能不同：
  // 响应式压缩后手动 /compact → seg 是过时的）。
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // 任何地方都没有 seg → 无操作。findUnresolvedToolUse 等读取完整 map。
  if (!lastSeg) {
    return
  }

  // seg 过时（无 seg 的 boundary 在其后出现）：跳过重新链接，仍在绝对
  // 位置裁剪 — 否则过时的保留链变成幽灵叶子。
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // 在修改之前验证 tail→head，使格式错误的 metadata 真正
  // 无操作（遍历在 headUuid 处停止，不需要先运行重新链接）。
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // tail→head 遍历中断 — 保留段中的某个 UUID 不在 transcript 中。
      // 此处返回会跳过下面的裁剪，因此恢复会加载完整的压缩前历史。
      // 已知原因：轮中产生的 attachment 推入 mutableMessages 但从未
      // recordTranscript（SDK 子进程在下一轮的 qe:420 flush 之前重启）。
      logEvent('zy_relink_walk_broken', {
        tailInTranscript: messages.has(lastSeg.tailUuid),
        headInTranscript: messages.has(lastSeg.headUuid),
        anchorInTranscript: messages.has(lastSeg.anchorUuid),
        walkSteps: walkSeen.size,
        transcriptSize: messages.size,
      })
      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // 尾部拼接：anchor 的其他子节点 → tail。如果已指向 tail
    // 则无操作（useLogMessages 竞争情况）。
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // 归零过时用量：磁盘上的 input_tokens 反映压缩前上下文
    // (~190K) — stripStaleUsage 只修补了被去重跳过的内存副本。
    // 没有这个，恢复 → 立即自动压缩螺旋。
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') {
        continue
      }
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // 裁剪绝对最后 boundary 之前所有未保留的内容。
  // !segIsLive 时 preservedUuids 为空 → 完全裁剪。
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (idx !== undefined && idx < absoluteLastBoundaryIdx && !preservedUuids.has(uuid)) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) {
    messages.delete(uuid)
  }
}

/**
 * 删除 Snip 执行从内存数组中移除的消息，
 * 并跨越空隙重新链接 parentUuid。
 *
 * 与截断前缀的 compact_boundary 不同，snip 移除中间范围。
 * JSONL 是仅追加的，因此被移除的消息仍留在磁盘上，
 * 存活消息的 parentUuid 链会穿过它们。没有此过滤器，
 * buildConversationChain 会重建完整的未 snip 历史，恢复时立即
 * PTL（adamr-20260320-165831: 显示 397K → 实际 1.65M）。
 *
 * 仅删除是不够的：被移除范围之后的存活消息的
 * parentUuid 指向空隙内部。buildConversationChain 会命中
 * messages.get(undefined) 并停止，使空隙之前的所有内容成为孤儿。
 * 因此删除后我们重新链接：对每个具有悬挂 parentUuid 的存活者，
 * 通过被移除区域自己的父链接向后遍历到第一个未被移除的祖先。
 *
 * boundary 在执行时记录 removedUuids，以便我们可以在加载时
 * 重放精确的移除。没有 removedUuids 的旧 boundary 被跳过 —
 * 恢复会加载它们的 snip 前历史（修复前的行为）。
 *
 * 原地修改 Map。
 */
function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  // 结构检查 — snipMetadata 仅存在于 boundary 子类型上。
  // 避免使用在 excluded-strings.txt 中的子类型字面量
  // （HISTORY_SNIP 仅限 ant；字面量不得泄漏到外部构建）。
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) {
      continue
    }
    for (const uuid of removedUuids) {
      toDelete.add(uuid)
    }
  }
  if (toDelete.size === 0) {
    return
  }

  // 在删除之前捕获每个待删除 entry 自己的 parentUuid，以便我们可以
  // 通过连续的已移除范围向后遍历。不在 Map 中的 entry
  // （已缺失，例如来自先前的 compact_boundary 裁剪）不提供链接；
  // 重新链接遍历会在空隙处停止并获取 null（链根行为 —
  // 与 compact 在那里截断相同，实际上它确实这样做了）。
  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) {
      continue
    }
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  // 重新链接具有悬挂 parentUuid 的存活者。通过 deletedParent
  // 向后遍历直到命中不在 toDelete 中的 UUID（或 null）。
  // 路径压缩：解析后将解析结果种入 map，使后续共享
  // 相同链段的存活者不必重新遍历。
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) {
      deletedParent.set(p, cur)
    }
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) {
      continue
    }
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }

  logEvent('zy_snip_resume_filtered', {
    removed_count: removedCount,
    relinked_count: relinkedCount,
  })
}

/**
 * O(n) 单次遍历：找到匹配谓词的最新时间戳的消息。
 * 替代 `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` 模式，
 * 该模式为 O(n log n) + 2n 次 Date 分配。
 */
function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) {
      continue
    }
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * 从叶子消息到根节点构建对话链
 * @param messages 所有消息的 Map
 * @param leafMessage 起始的叶子消息
 * @returns 从根到叶的消息数组
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      logEvent('zy_chain_parent_cycle', {})
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid ? messages.get(currentMsg.parentUuid) : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

/**
 * buildConversationChain 的后处理：恢复单父遍历使之成为孤儿的
 * 兄弟 assistant 块和 tool_result。
 *
 * 流式传输（zy.ts:~2024）每个 content_block_stop 发出一个 AssistantMessage
 * — N 个并行 tool_use → N 条消息，不同 uuid，相同 message.id。每个
 * tool_result 的 sourceToolAssistantUUID 指向其自己的单块 assistant，
 * 因此 insertMessageChain 的覆写（约第 894 行）将每个 TR 的 parentUuid
 * 写入不同的 assistant。拓扑是 DAG；上面的遍历是链表遍历，只保留一个分支。
 *
 * 在生产中观察到的两种丢失模式（两者均在此修复）：
 *   1. 兄弟 assistant 成为孤儿：遍历走 prev→asstA→TR_A→next，丢弃 asstB
 *      （相同 message.id，从 asstA 链接）和 TR_B。
 *   2. Progress-fork（遗留，pre-#23537）：每个 tool_use asst 有一个 progress
 *      子节点（继续写入链）和一个 TR 子节点。遍历跟随
 *      progress；TR 被丢弃。不再写入（progress 已从 transcript 持久化
 *      中移除），但旧 transcript 仍有此形状。
 *
 * 读侧修复：写入拓扑已在磁盘上（对于旧 transcript）；
 * 此恢复遍历处理它们。
 */
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter((m): m is ChainAssistant => m.type === 'assistant')
  if (chainAssistants.length === 0) {
    return chain
  }

  // Anchor = 每个兄弟组的最后一个链上成员。chainAssistants 已按
  // 链顺序排列，因此后面的迭代覆写 → 后者优先。
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) {
      anchorByMsgId.set(a.message.id, a)
    }
  }

  // O(n) 预计算：兄弟组和 TR 索引。
  // TR 按 parentUuid 索引 — insertMessageChain:~894 已将其写为
  // srcUUID，--fork-session 剥离 srcUUID 但保留 parentUuid。
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) {
        group.push(m)
      } else {
        siblingsByMsgId.set(m.message.id, [m])
      }
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some((b) => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) {
        group.push(m)
      } else {
        toolResultsByAsst.set(m.parentUuid, [m])
      }
    }
  }

  // 对于每个触及链的 message.id 组：收集链外兄弟，
  // 然后收集所有成员的链外 TR。在最后一个链上成员之后拼接，
  // 使组对 normalizeMessagesForAPI 的合并保持连续，
  // 并且每个 TR 都落在其 tool_use 之后。
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) {
      continue
    }
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter((s) => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) {
        continue
      }
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) {
          orphanedTRs.push(tr)
        }
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) {
      continue
    }

    // 时间戳排序保持 content-block / completion 顺序；
    // 稳定排序在相同时保留 JSONL 写入顺序。
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) {
      seen.add(r.uuid)
    }
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) {
    return chain
  }
  logEvent('zy_chain_parallel_tr_recovered', {
    recovered_count: recoveredCount,
  })

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) {
      result.push(...toInsert)
    }
  }
  return result
}

/**
 * 在重建的链中找到最新的 turn_duration 检查点，并将其记录的
 * messageCount 与该点的链位置进行比较。发出 zy_resume_consistency_delta
 * 用于 BigQuery 监控写入→加载往返漂移 — 即 snip/compact/并行-TR
 * 操作修改内存但磁盘上的 parentUuid 遍历重建了不同集合的
 * bug 类别（adamr-20260320-165831: 显示 397K → 恢复时实际 1.65M）。
 *
 * delta > 0: 恢复加载了比 session 内更多（常见失败模式）
 * delta < 0: 恢复加载了更少（链截断 — #22453 类别）
 * delta = 0: 往返一致
 *
 * 从 loadConversationForResume 调用 — 每次恢复触发一次，不在
 * /share 或日志列表链重建时触发。
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') {
      continue
    }
    const expected = m.messageCount
    if (expected === undefined) {
      return
    }
    // `i` 是检查点在重建链中的 0 基索引。
    // 检查点在 messageCount 条消息之后追加，因此它自己的
    // 位置应为 messageCount（即 i === expected）。
    const actual = i
    logEvent('zy_resume_consistency_delta', {
      expected,
      actual,
      delta: actual - expected,
      chain_length: chain.length,
      checkpoint_age_entries: chain.length - 1 - i,
    })
    return
  }
}

/**
 * 从对话中构建文件历史快照链
 */
function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → snapshots[] 中的最后索引，用于 O(1) 更新查找
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate ? indexByMessageId.get(snapshot.messageId) : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * 从对话中构建归因快照链。
 * 与文件历史快照不同，归因快照完整返回，因为它们使用
 * 生成的 UUID（非消息 UUID）并表示应在 session 恢复时还原的累积状态。
 */
function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // 返回所有归因快照 - 它们将在恢复时合并
  return Array.from(attributionSnapshots.values())
}

/**
 * 从 JSON 或 JSONL 文件加载 transcript 并转换为 LogOption 格式
 * @param filePath transcript 文件的路径（.json 或 .jsonl）
 * @returns 包含 transcript 消息的 LogOption
 * @throws 如果文件不存在或包含无效数据则抛出错误
 */
export async function loadTranscriptFromFile(filePath: string): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      fileHistorySnapshots,
      attributionSnapshots,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
      contentReplacements,
      worktreeStates,
    } = await loadTranscriptFile(filePath)

    if (messages.size === 0) {
      throw new Error('No messages found in JSONL file')
    }

    // 使用预计算的叶子 UUID 找到最近的叶子消息
    const leafMessage = findLatestMessage(messages.values(), (msg) => leafUuids.has(msg.uuid))

    if (!leafMessage) {
      throw new Error('No valid conversation chain found in JSONL file')
    }

    // 从叶子到根反向构建对话链
    const transcript = buildConversationChain(messages, leafMessage)

    const summary = summaries.get(leafMessage.uuid)
    const customTitle = customTitles.get(leafMessage.sessionId as UUID)
    const tag = tags.get(leafMessage.sessionId as UUID)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        customTitle,
        buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
        tag,
        filePath,
        buildAttributionSnapshotChain(attributionSnapshots, transcript),
        undefined,
        contentReplacements.get(sessionId) ?? [],
      ),
      contextCollapseCommits: contextCollapseCommits.filter((e) => e.sessionId === sessionId),
      contextCollapseSnapshot:
        contextCollapseSnapshot?.sessionId === sessionId ? contextCollapseSnapshot : undefined,
      worktreeSession: worktreeStates.has(sessionId) ? worktreeStates.get(sessionId) : undefined,
    }
  }

  // json 日志文件
  const content = await readFile(filePath, { encoding: 'utf-8' })
  let parsed: unknown

  try {
    parsed = jsonParse(content)
  } catch (error) {
    throw new Error(`Invalid JSON in transcript file: ${error}`)
  }

  let messages: TranscriptMessage[]

  if (Array.isArray(parsed)) {
    messages = parsed
  } else if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
    if (!Array.isArray(parsed.messages)) {
      throw new Error('Transcript messages must be an array')
    }
    messages = parsed.messages
  } else {
    throw new Error('Transcript must be an array of messages or an object with a messages array')
  }

  return convertToLogOption(messages, 0, undefined, undefined, undefined, undefined, filePath)
}

/**
 * 检查用户消息是否有可见内容（文本或图片，不仅是 tool_result）。
 * 工具结果作为折叠组的一部分显示，而非独立消息。
 * 也排除不向用户显示的 meta 消息。
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') {
    return false
  }

  // meta 消息不向用户显示
  if (message.isMeta) {
    return false
  }

  const content = message.message?.content
  if (!content) {
    return false
  }

  // 字符串内容总是可见的
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  // 数组内容：检查文本或图片块（非 tool_result）
  if (Array.isArray(content)) {
    return content.some(
      (block) => block.type === 'text' || block.type === 'image' || block.type === 'document',
    )
  }

  return false
}

/**
 * 检查 assistant 消息是否有可见的文本内容（不仅是 tool_use 块）。
 * 工具使用作为分组/折叠的 UI 元素显示，而非独立消息。
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') {
    return false
  }

  const content = message.message?.content
  if (!content || !Array.isArray(content)) {
    return false
  }

  // 检查文本块（不仅是 tool_use/thinking 块）
  return content.some(
    (block) =>
      block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/**
 * 计算在 UI 中显示为对话轮次的可见消息数。
 * 排除：
 * - system、attachment 和 progress 消息
 * - 带有 isMeta 标志的用户消息（对用户隐藏）
 * - 仅包含 tool_result 块的用户消息（作为折叠组显示）
 * - 仅包含 tool_use 块的 assistant 消息（作为折叠组显示）
 */
function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // 计算具有可见内容的用户消息（文本、图片，不仅是 tool_result 或 meta）
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // 计算具有文本内容的 assistant 消息（不仅是 tool_use）
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // 这些消息类型不计为可见的对话轮次
        break
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // 获取首条用户消息作为 prompt
  const firstPrompt = extractFirstPrompt(transcript)

  // 从消息时间戳创建时间戳
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

async function trackSessionBranchingAnalytics(logs: LogOption[]): Promise<void> {
  const sessionIdCounts = new Map<string, number>()
  let maxCount = 0
  for (const log of logs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const newCount = (sessionIdCounts.get(sessionId) || 0) + 1
      sessionIdCounts.set(sessionId, newCount)
      maxCount = Math.max(newCount, maxCount)
    }
  }

  // 如果未检测到重复则提前退出
  if (maxCount <= 1) {
    return
  }

  // 使用函数式方法统计有分支的 session 数量并计算统计信息
  const branchCounts = Array.from(sessionIdCounts.values()).filter((c) => c > 1)
  const sessionsWithBranches = branchCounts.length
  const totalBranches = branchCounts.reduce((sum, count) => sum + count, 0)

  logEvent('zy_session_forked_branches_fetched', {
    total_sessions: sessionIdCounts.size,
    sessions_with_branches: sessionsWithBranches,
    max_branches_per_session: Math.max(...branchCounts),
    avg_branches_per_session: Math.round(totalBranches / sessionsWithBranches),
    total_transcript_count: logs.length,
  })
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  const logs = await getSessionFilesLite(projectDir, limit, getOriginalCwd())

  await trackSessionBranchingAnalytics(logs)

  return logs
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

/**
 * 从日志中提取 session ID。
 * 对于 lite 日志，直接使用 sessionId 字段。
 * 对于完整日志，从首条消息中提取。
 */
export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  // 对于 lite 日志，使用直接的 sessionId 字段
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  // 回退到从首条消息中提取（完整日志）
  return log.messages[0]?.sessionId as UUID | undefined
}

/**
 * 检查日志是否为需要完整加载的 lite 日志。
 * lite 日志的 messages 为 [] 且 sessionId 已设置。
 */
export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

/**
 * 通过读取 JSONL 文件为 lite 日志加载完整消息。
 * 返回填充了 messages 数组的新 LogOption。
 * 如果日志已是完整的或加载失败，返回原始日志。
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  // 如果已是完整的，按原样返回
  if (!isLiteLog(log)) {
    return log
  }

  // 直接使用索引条目中的 fullPath
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      agentNames,
      agentColors,
      agentSettings,
      prNumbers,
      prUrls,
      prRepositories,
      modes,
      worktreeStates,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
    } = await loadTranscriptFile(sessionFile)

    if (messages.size === 0) {
      return log
    }

    // 从 transcript 中找到最近的 user/assistant 叶子消息
    const mostRecentLeaf = findLatestMessage(
      messages.values(),
      (msg) => leafUuids.has(msg.uuid) && (msg.type === 'user' || msg.type === 'assistant'),
    )
    if (!mostRecentLeaf) {
      return log
    }

    // 从此叶子构建对话链
    const transcript = buildConversationChain(messages, mostRecentLeaf)
    // 叶子的 sessionId — fork 的 session 从源复制 chain[0]，但
    // metadata entry（custom-title 等）以当前 session 为键。
    const sessionId = mostRecentLeaf.sessionId as UUID | undefined
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt: extractFirstPrompt(transcript),
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf ? summaries.get(mostRecentLeaf.uuid) : log.summary,
      customTitle: sessionId ? customTitles.get(sessionId) : log.customTitle,
      tag: sessionId ? tags.get(sessionId) : log.tag,
      agentName: sessionId ? agentNames.get(sessionId) : log.agentName,
      agentColor: sessionId ? agentColors.get(sessionId) : log.agentColor,
      agentSetting: sessionId ? agentSettings.get(sessionId) : log.agentSetting,
      mode: sessionId ? (modes.get(sessionId) as LogOption['mode']) : log.mode,
      worktreeSession:
        sessionId && worktreeStates.has(sessionId)
          ? worktreeStates.get(sessionId)
          : log.worktreeSession,
      prNumber: sessionId ? prNumbers.get(sessionId) : log.prNumber,
      prUrl: sessionId ? prUrls.get(sessionId) : log.prUrl,
      prRepository: sessionId ? prRepositories.get(sessionId) : log.prRepository,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      teamName: transcript[0]?.teamName ?? log.teamName,
      leafUuid: mostRecentLeaf?.uuid ?? log.leafUuid,
      fileHistorySnapshots: buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      attributionSnapshots: buildAttributionSnapshotChain(attributionSnapshots, transcript),
      contentReplacements: sessionId
        ? (contentReplacements.get(sessionId) ?? [])
        : log.contentReplacements,
      // 过滤到恢复的 session 的 entry。loadTranscriptFile 顺序读取
      // 文件，因此数组已按提交顺序排列；过滤保持该顺序。
      contextCollapseCommits: sessionId
        ? contextCollapseCommits.filter((e) => e.sessionId === sessionId)
        : undefined,
      contextCollapseSnapshot:
        sessionId && contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
    }
  } catch {
    // 如果加载失败，返回原始日志
    return log
  }
}

/**
 * 按自定义标题匹配搜索 session。
 * 返回按时间排序的匹配结果（最新优先）。
 * 使用不区分大小写的匹配以获得更好的用户体验。
 * 按 sessionId 去重（每个 session 保留最新的）。
 * 默认搜索同仓库的 worktree。
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  // 使用 worktree 感知加载以搜索同仓库的 session
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // 丰富所有日志以访问 customTitle metadata
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter((log) => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) {
      return false
    }
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // 按 sessionId 去重 - 如果是同一对话的不同分支，
  // 多个日志可能有相同的 sessionId。保留最新的。
  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  // 按时间排序
  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  // 如果指定了限制则应用
  if (limit) {
    return deduplicated.slice(0, limit)
  }

  return deduplicated
}

/**
 * 可出现在 compact boundary 之前但仍必须加载的 metadata entry 类型
 * （它们是 session 范围的，非消息范围的）。
 * 保持为原始 JSON 字符串标记，用于流式处理期间的廉价行过滤。
 */
const METADATA_TYPE_MARKERS = [
  '"type":"summary"',
  '"type":"custom-title"',
  '"type":"tag"',
  '"type":"agent-name"',
  '"type":"agent-color"',
  '"type":"agent-setting"',
  '"type":"mode"',
  '"type":"worktree-state"',
  '"type":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map((m) => Buffer.from(m))
// 最长标记为 22 字节；+1（前导 `{`）= 23。
const METADATA_PREFIX_BOUND = 25

// null = carry 跨越整个 chunk。当 carry 明确不是 metadata 行时
// 跳过拼接（标记位于 `{` 后的第 1 字节）。
function resolveMetadataBuf(carry: Buffer | null, chunkBuf: Buffer): Buffer | null {
  if (carry === null || carry.length === 0) {
    return chunkBuf
  }
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (carry[0] === 0x7b /* { */) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.compare(m, 0, m.length, 1, 1 + m.length) === 0) {
        return Buffer.concat([carry, chunkBuf])
      }
    }
  }
  const firstNl = chunkBuf.indexOf(0x0a)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

/**
 * [0, endOffset) 的轻量级前向扫描，仅收集 metadata entry 行。
 * 使用原始 Buffer chunk 和字节级标记匹配 — 不使用 readline，
 * 对 ~99% 为消息内容的行不进行逐行字符串转换。
 *
 * 快速路径：如果 chunk 不包含任何标记（常见情况 — 每个 session
 * 的 metadata entry 少于 50 个），整个 chunk 跳过而不拆分行。
 */
async function scanPreBoundaryMetadata(filePath: string, endOffset: number): Promise<string[]> {
  const { createReadStream } = await import('node:fs')
  const NEWLINE = 0x0a

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    // 快速路径：大多数 chunk 不包含 metadata 标记。跳过行拆分。
    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        // 有界标记检查：仅在此行的字节范围内查找
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString('utf-8', lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      // 此 chunk 中无标记 — 仅保留不完整的尾行
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // 防止病态巨大行（例如无换行符的 10 MB 工具输出行）导致的
    // carry 二次增长。真实 metadata entry 小于 1 KB，因此如果 carry
    // 超过此值则我们在消息内容中间 — 丢弃它。
    if (carry.length > 64 * 1024) {
      carry = null
    }
  }

  // 最后的不完整行（endOffset 处无尾部换行符）
  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString('utf-8'))
        break
      }
    }
  }

  return metadataLines
}

/**
 * 字节级预过滤器，在 parseJSONL 之前剔除死 fork 分支。
 *
 * 每次 rewind/ctrl-z 在仅追加的 JSONL 中永久留下一个孤立的链分支。
 * buildConversationChain 从最新叶子遍历 parentUuid 并丢弃其余，
 * 但此时 parseJSONL 已经为所有内容付出了 JSON.parse 的代价。
 * 在 fork 密集的 session 上测量：
 *
 *   41 MB, 99% 死：parseJSONL 56.0 ms -> 3.9 ms (-93%)
 *   151 MB, 92% 死：47.3 ms -> 9.4 ms (-80%)
 *
 * 死分支少（5-7%）的 session 从索引遍历的开销大致抵消解析
 * 节省中获得微小收益，因此以缓冲区大小为门控
 * （与 SKIP_PRECOMPACT_THRESHOLD 相同的阈值）。
 *
 * 依赖于在本地 session 中 25k+ 条消息行上验证的两个不变量
 * （0 违规）：
 *
 *   1. transcript 消息始终以 parentUuid 作为第一个键序列化。
 *      JSON.stringify 按插入顺序发出键，recordTranscript 的对象字面量
 *      将 parentUuid 放在第一位。因此 `{"parentUuid":` 是区分
 *      transcript 消息和 metadata 的稳定行前缀。
 *
 *   2. 顶层 uuid 检测由后缀检查 + 深度检查处理（见扫描循环中的
 *      行内注释）。toolUseResult/mcpMeta 在 uuid 之后序列化任意
 *      服务器控制的对象，agent_progress entry 在 uuid 之前序列化
 *      嵌套的 Message 在 data 中 — 两者都可能产生嵌套的
 *      `"uuid":"<36>","timestamp":"` 字节，因此仅后缀不够。
 *      当存在多个后缀匹配时，花括号深度扫描消除歧义。
 *
 * 仅追加的写入纪律保证父级出现在比子级更早的文件偏移处，
 * 因此从 EOF 向后遍历总能找到它们。
 */

/**
 * 通过找到 JSON 嵌套深度为 1 的匹配来消除一行中多个
 * `"uuid":"<36>","timestamp":"` 匹配的歧义。字符串感知的花括号计数器：
 * 字符串值中的 `{`/`}` 不计入；字符串中的 `\"` 和 `\\` 已处理。
 * candidates 按升序排列（扫描循环按字节顺序产生它们）。
 * 返回第一个深度为 1 的 candidate，如果没有深度为 1 的则返回最后一个
 * （格式正确的 JSONL 不应出现 — 深度 1 是顶层对象字段所在的位置）。
 *
 * 仅在存在 ≥2 个后缀匹配时调用（带有嵌套 Message 的 agent_progress，
 * 或具有巧合后缀对象的 mcpMeta）。代价为
 * O(max(candidates) - lineStart) — 一次前向字节遍历，在
 * 第一个深度 1 命中时停止。
 */
function pickDepthOneUuidCandidate(buf: Buffer, lineStart: number, candidates: number[]): number {
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN_BRACE = 0x7b
  const CLOSE_BRACE = 0x7d
  let depth = 0
  let inString = false
  let escapeNext = false
  let ci = 0
  for (let i = lineStart; ci < candidates.length; i++) {
    if (i === candidates[ci]) {
      if (depth === 1 && !inString) {
        return candidates[ci]!
      }
      ci++
    }
    const b = buf[i]!
    if (escapeNext) {
      escapeNext = false
    } else if (inString) {
      if (b === BACKSLASH) {
        escapeNext = true
      } else if (b === QUOTE) {
        inString = false
      }
    } else if (b === QUOTE) {
      inString = true
    } else if (b === OPEN_BRACE) {
      depth++
    } else if (b === CLOSE_BRACE) {
      depth--
    }
  }
  return candidates.at(-1)!
}

function walkChainBeforeParse(buf: Buffer): Buffer {
  const NEWLINE = 0x0a
  const OPEN_BRACE = 0x7b
  const QUOTE = 0x22
  const PARENT_PREFIX = Buffer.from('{"parentUuid":')
  const UUID_KEY = Buffer.from('"uuid":"')
  const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
  const UUID_LEN = 36
  const TS_SUFFIX = Buffer.from('","timestamp":"')
  const TS_SUFFIX_LEN = TS_SUFFIX.length
  const PREFIX_LEN = PARENT_PREFIX.length
  const KEY_LEN = UUID_KEY.length

  // transcript 消息的步长 3 扁平索引：[lineStart, lineEnd, parentStart]。
  // parentStart 是父 uuid 首字符的字节偏移，null 时为 -1。
  // metadata 行（summary、mode、file-history-snapshot 等）不过滤地放入 metaRanges
  // - 它们缺少 parentUuid 前缀，下游需要所有这些行。
  const msgIdx: number[] = []
  const metaRanges: number[] = []
  const uuidToSlot = new Map<string, number>()

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    if (
      lineEnd - pos > PREFIX_LEN &&
      buf[pos] === OPEN_BRACE &&
      buf.compare(PARENT_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      // `{"parentUuid":null,` 或 `{"parentUuid":"<36 chars>",`
      const parentStart = buf[pos + PREFIX_LEN] === QUOTE ? pos + PREFIX_LEN + 1 : -1
      // 顶层 uuid 在 user/assistant/attachment entry 中紧跟
      // `","timestamp":"`（create* 辅助函数将它们相邻放置；两者始终有定义）。
      // 但后缀不唯一：
      //   - agent_progress entry 在 data.message 中携带嵌套 Message，
      //     在顶层 uuid 之前序列化 — 该内部 Message 有自己的相邻
      //     uuid,timestamp，因此其字节也满足后缀检查。
      //   - mcpMeta/toolUseResult 在顶层 uuid 之后并持有
      //     服务器控制的 Record<string,unknown> — 返回
      //     {uuid:"<36>",timestamp:"..."} 的服务器也会匹配。
      // 收集所有后缀匹配；单个是无歧义的（常见情况），多个需要
      // 花括号深度检查以选择 JSON 嵌套深度为 1 的那个。
      // 没有后缀匹配的 entry（某些 progress 变体将 timestamp 放在
      // uuid 之前 → 行尾 `"uuid":"<36>"}` ）只有一个 `"uuid":"`，
      // 第一个匹配的回退是合理的。
      let firstAny = -1
      let suffix0 = -1
      let suffixN: number[] | undefined
      let from = pos
      for (;;) {
        const next = buf.indexOf(UUID_KEY, from)
        if (next < 0 || next >= lineEnd) {
          break
        }
        if (firstAny < 0) {
          firstAny = next
        }
        const after = next + KEY_LEN + UUID_LEN
        if (
          after + TS_SUFFIX_LEN <= lineEnd &&
          buf.compare(TS_SUFFIX, 0, TS_SUFFIX_LEN, after, after + TS_SUFFIX_LEN) === 0
        ) {
          if (suffix0 < 0) {
            suffix0 = next
          } else {
            ;(suffixN ??= [suffix0]).push(next)
          }
        }
        from = next + KEY_LEN
      }
      const uk = suffixN
        ? pickDepthOneUuidCandidate(buf, pos, suffixN)
        : suffix0 >= 0
          ? suffix0
          : firstAny
      if (uk >= 0) {
        const uuidStart = uk + KEY_LEN
        // UUID 是纯 ASCII，因此 latin1 避免 UTF-8 解码开销。
        const uuid = buf.toString('latin1', uuidStart, uuidStart + UUID_LEN)
        uuidToSlot.set(uuid, msgIdx.length)
        msgIdx.push(pos, lineEnd, parentStart)
      } else {
        metaRanges.push(pos, lineEnd)
      }
    } else {
      metaRanges.push(pos, lineEnd)
    }
    pos = lineEnd
  }

  // 叶子 = 最后一个非 sidechain entry。isSidechain 是第 2 或第 3 个键
  // （在 parentUuid 之后，可能是 logicalParentUuid），因此从 lineStart
  // indexOf 在存在时几十字节内找到；不存在时溢出到下一行，被边界检查捕获。
  let leafSlot = -1
  for (let i = msgIdx.length - 3; i >= 0; i -= 3) {
    const sc = buf.indexOf(SIDECHAIN_TRUE, msgIdx[i]!)
    if (sc === -1 || sc >= msgIdx[i + 1]!) {
      leafSlot = i
      break
    }
  }
  if (leafSlot < 0) {
    return buf
  }

  // 遍历 parentUuid 到根。收集保留消息的行起始位置并累加它们的
  // 字节长度，以便决定拼接是否值得。悬挂的父级（uuid 不在文件中）
  // 是 fork session 和 boundary 后链的正常终止 -- 与 buildConversationChain
  // 语义相同。针对索引毒化的正确性依赖于上面的时间戳后缀检查：
  // 没有后缀的嵌套 `"uuid":"` 匹配永远不会成为 uk。
  const seen = new Set<number>()
  const chain = new Set<number>()
  let chainBytes = 0
  let slot: number | undefined = leafSlot
  while (slot !== undefined) {
    if (seen.has(slot)) {
      break
    }
    seen.add(slot)
    chain.add(msgIdx[slot]!)
    chainBytes += msgIdx[slot + 1]! - msgIdx[slot]!
    const parentStart = msgIdx[slot + 2]!
    if (parentStart < 0) {
      break
    }
    const parent = buf.toString('latin1', parentStart, parentStart + UUID_LEN)
    slot = uuidToSlot.get(parent)
  }

  // parseJSONL 代价随字节而非 entry 数量增长。session 可能按数量有
  // 数千个死 entry，但如果死分支是短轮次而活跃链持有大量 assistant
  // 响应，则字节只有个位数百分比（实测：107 MB session，69% 死 entry，
  // 30% 死字节 - 索引+拼接开销超过解析节省）。以字节为门控：
  // 仅在丢弃至少一半缓冲区时才拼接。metadata 很小，
  // 因此 len - chainBytes 足够近似死字节。
  // 接近收支平衡时 concat memcpy（将 chainBytes 复制到新分配）
  // 占主导，因此保守的 50% 门控安全地保持在获胜一侧。
  if (len - chainBytes < len >> 1) {
    return buf
  }

  // 按原始文件顺序合并链 entry 和 metadata。msgIdx 和 metaRanges
  // 都已按偏移排序；将它们交错为子数组视图并一次性拼接。
  const parts: Buffer[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
      m += 2
    }
    if (chain.has(start)) {
      parts.push(buf.subarray(start, msgIdx[i + 1]!))
    }
  }
  while (m < metaRanges.length) {
    parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
    m += 2
  }
  return Buffer.concat(parts)
}

/**
 * 修复 transcript messages 中损坏的 parentUuid 链。
 * 正常文件零开销：先快速扫描，没有断链则直接返回。
 * 有断链时按 session 分组 + timestamp 排序修复：
 * - parentUuid=null → 修复为前一条消息的 uuid
 * - parentUuid 指向不存在的 UUID → 修复为前一条消息的 uuid
 * - sidechain 消息排除（不参与主链修复）
 * - compact_boundary 的 parentUuid=null 是有意为之，不修复
 */
function repairBrokenParentUuidChains(messages: Map<UUID, TranscriptMessage>): void {
  // 快速扫描：检查是否有需要修复的消息
  let hasBroken = false
  for (const msg of messages.values()) {
    if (msg.isSidechain || isCompactBoundaryMessage(msg)) {
      continue
    }
    if (!msg.parentUuid || !messages.has(msg.parentUuid)) {
      hasBroken = true
      break
    }
  }
  if (!hasBroken) {
    return
  }

  // 按 sessionId 分组（排除 sidechain 和 compact_boundary）
  const bySession = new Map<string, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (msg.isSidechain || isCompactBoundaryMessage(msg)) {
      continue
    }
    const sid = (msg.sessionId as string) ?? '__root__'
    if (!bySession.has(sid)) {
      bySession.set(sid, [])
    }
    bySession.get(sid)!.push(msg)
  }

  // 时间顺序即真实顺序，修复损坏的 parentUuid
  for (const group of bySession.values()) {
    group.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    for (let i = 1; i < group.length; i++) {
      const msg = group[i]!
      if (!msg.parentUuid || !messages.has(msg.parentUuid)) {
        msg.parentUuid = group[i - 1]!.uuid
      }
    }
  }
}

/**
 * 从 transcript 文件加载所有消息、摘要和文件历史快照。
 * 返回消息、摘要、自定义标题、标签、文件历史快照和归因快照。
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}> {
  const messages = new Map<UUID, TranscriptMessage>()
  const summaries = new Map<UUID, string>()
  const customTitles = new Map<UUID, string>()
  const tags = new Map<UUID, string>()
  const agentNames = new Map<UUID, string>()
  const agentColors = new Map<UUID, string>()
  const agentSettings = new Map<UUID, string>()
  const prNumbers = new Map<UUID, number>()
  const prUrls = new Map<UUID, string>()
  const prRepositories = new Map<UUID, string>()
  const modes = new Map<UUID, string>()
  const worktreeStates = new Map<UUID, PersistedWorktreeSession | null>()
  const fileHistorySnapshots = new Map<UUID, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<UUID, AttributionSnapshotMessage>()
  const contentReplacements = new Map<UUID, ContentReplacementRecord[]>()
  const agentContentReplacements = new Map<AgentId, ContentReplacementRecord[]>()
  // 数组而非 Map — 提交顺序重要（嵌套折叠）。
  const contextCollapseCommits: ContextCollapseCommitEntry[] = []
  // 后者优先 — 后面的 entry 取代前面的。
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined

  try {
    // 对于大型 transcript，避免物化数 MB 的过时内容。
    // 单次前向分块读取：attribution-snapshot 行在 fd 级别被跳过
    // （从不缓冲），compact boundary 在流中截断累加器。
    // 峰值分配是输出大小而非文件大小 — 一个 84% 为过时 attr-snap 的
    // 151 MB session 分配 ~32 MB 而非 159+64 MB。这很重要因为 mimalloc
    // 即使在 JS 级 GC 释放底层缓冲区后也不将这些页返回 OS
    // （实测：Bun.gc(true) 后 arrayBuffers=0 但旧的 scan+strip 路径
    // RSS 停在 ~316 MB vs 此处 ~155 MB）。
    //
    // 边界前 metadata（agent-setting、mode、pr-link 等）通过
    // [0, boundary) 的廉价字节级前向扫描恢复。
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (!isEnvTruthy(process.env.ZY_CODE_DISABLE_PRECOMPACT_SKIP)) {
      const { size } = await stat(filePath)
      if (size > SKIP_PRECOMPACT_THRESHOLD) {
        const scan = await readTranscriptForLoad(filePath, size)
        buf = scan.postBoundaryBuf
        hasPreservedSegment = scan.hasPreservedSegment
        // >0 表示我们截断了 boundary 前的字节，必须从该范围恢复
        // session 范围的 metadata。preservedSegment boundary 不截断
        // （保留的消息物理上在 boundary 之前），因此偏移保持 0，
        // 除非更早的非 preserved boundary 已截断 — 在这种情况下
        // 后面 boundary 的保留消息在那个更早 boundary 之后并被保留，
        // 我们仍需要 metadata 扫描。
        if (scan.boundaryStartOffset > 0) {
          metadataLines = await scanPreBoundaryMetadata(filePath, scan.boundaryStartOffset)
        }
      }
    }
    buf ??= await readFile(filePath)
    // 对于大缓冲区（此处指 readTranscriptForLoad 输出，attr-snap 已在 fd
    // 级别剥离 — <5MB 的 readFile 路径通过下面的大小门控），主要代价是
    // 解析 buildConversationChain 无论如何会丢弃的死 fork 分支。在以下情况
    // 跳过：调用者需要所有叶子（loadAllLogsFromSessionFile 用于 /insights
    // 选择用户消息最多的分支而非最新的），boundary 有 preservedSegment
    // （这些消息在磁盘上保持其压缩前 parentUuid -- applyPreservedSegmentRelinks
    // 在解析后在内存中拼接它们，因此解析前的链遍历会将它们作为孤儿丢弃），
    // 以及设置了 ZY_CODE_DISABLE_PRECOMPACT_SKIP（该 kill switch 意味着
    // "加载一切，不跳过"；这是另一个解析前跳过优化，且其依赖的
    // hasPreservedSegment 扫描未运行）。
    if (
      !opts?.keepAllLeaves &&
      !hasPreservedSegment &&
      !isEnvTruthy(process.env.ZY_CODE_DISABLE_PRECOMPACT_SKIP) &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD
    ) {
      buf = walkChainBeforeParse(buf)
    }

    // 第一遍：处理边界扫描期间收集的仅 metadata 行。
    // 这些为 compact boundary 之前写入的 entry 填充 session 范围的 map
    // （agentSettings、modes、prNumbers 等）。与边界后缓冲区的任何重叠
    // 无害 — 后面的值覆盖前面的。
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(Buffer.from(metadataLines.join('\n')))
      for (const entry of metaEntries) {
        if (entry.type === 'summary' && entry.leafUuid) {
          summaries.set(entry.leafUuid, entry.summary)
        } else if (entry.type === 'custom-title' && entry.sessionId) {
          customTitles.set(entry.sessionId, entry.customTitle)
        } else if (entry.type === 'ai-title' && entry.sessionId) {
          // AI title 仅在无 custom-title 时回退使用
          if (!customTitles.has(entry.sessionId)) {
            customTitles.set(entry.sessionId, (entry as any).aiTitle)
          }
        } else if (entry.type === 'tag' && entry.sessionId) {
          tags.set(entry.sessionId, entry.tag)
        } else if (entry.type === 'agent-name' && entry.sessionId) {
          agentNames.set(entry.sessionId, entry.agentName)
        } else if (entry.type === 'agent-color' && entry.sessionId) {
          agentColors.set(entry.sessionId, entry.agentColor)
        } else if (entry.type === 'agent-setting' && entry.sessionId) {
          agentSettings.set(entry.sessionId, entry.agentSetting)
        } else if (entry.type === 'mode' && entry.sessionId) {
          modes.set(entry.sessionId, entry.mode)
        } else if (entry.type === 'worktree-state' && entry.sessionId) {
          worktreeStates.set(entry.sessionId, entry.worktreeSession)
        } else if (entry.type === 'pr-link' && entry.sessionId) {
          prNumbers.set(entry.sessionId, entry.prNumber)
          prUrls.set(entry.sessionId, entry.prUrl)
          prRepositories.set(entry.sessionId, entry.prRepository)
        }
      }
    }

    const entries = parseJSONL<Entry>(buf)

    // 遗留 progress entry 的桥接 map：progress_uuid → progress_parent_uuid。
    // PR #24099 从 isTranscriptMessage 移除了 progress，因此旧 transcript 中
    // parentUuid 链里的 progress 会在 messages.get(progressUuid) 返回
    // undefined 时使 buildConversationChain 截断。由于 transcript 是
    // 仅追加的（父在子前），我们在看到时记录每个 progress→parent 链接，
    // 通过连续 progress entry 链式解析，然后重写 parentUuid 落在桥接中的
    // 任何后续消息。
    const progressBridge = new Map<UUID, UUID | null>()

    for (const entry of entries) {
      // 遗留 progress 检查在 Entry 类型的 else-if 链之前运行 —
      // progress 不在 Entry 联合中，因此在 TypeScript 将 `entry`
      // 窄化为与 `never` 交叉后再检查它。
      if (isLegacyProgressEntry(entry)) {
        // 通过连续 progress entry 链式解析，使指向 progress 运行尾部的
        // 后续消息在一次查找中桥接到最近的非 progress 祖先。
        const parent = entry.parentUuid
        progressBridge.set(
          entry.uuid,
          parent && progressBridge.has(parent) ? (progressBridge.get(parent) ?? null) : parent,
        )
        continue
      }
      if (isTranscriptMessage(entry)) {
        if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
          entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
        }
        messages.set(entry.uuid, entry)
        // compact boundary：之前的 marble-origami-commit entry 引用了
        // 不会在 boundary 后链中的消息。>5MB 的反向扫描路径通过
        // 从不读取 boundary 前字节自然丢弃它们；<5MB 路径读取所有内容，
        // 因此在此处丢弃。否则 /context 中的 getStats().collapsedSpans
        // 会多计（projectView 静默跳过过时提交但它们仍在日志中）。
        if (isCompactBoundaryMessage(entry)) {
          contextCollapseCommits.length = 0
          contextCollapseSnapshot = undefined
        }
      } else if (entry.type === 'summary' && entry.leafUuid) {
        summaries.set(entry.leafUuid, entry.summary)
      } else if (entry.type === 'custom-title' && entry.sessionId) {
        customTitles.set(entry.sessionId, entry.customTitle)
      } else if (entry.type === 'ai-title' && entry.sessionId) {
        // AI title 仅在无 custom-title 时回退使用
        if (!customTitles.has(entry.sessionId)) {
          customTitles.set(entry.sessionId, (entry as any).aiTitle)
        }
      } else if (entry.type === 'tag' && entry.sessionId) {
        tags.set(entry.sessionId, entry.tag)
      } else if (entry.type === 'agent-name' && entry.sessionId) {
        agentNames.set(entry.sessionId, entry.agentName)
      } else if (entry.type === 'agent-color' && entry.sessionId) {
        agentColors.set(entry.sessionId, entry.agentColor)
      } else if (entry.type === 'agent-setting' && entry.sessionId) {
        agentSettings.set(entry.sessionId, entry.agentSetting)
      } else if (entry.type === 'mode' && entry.sessionId) {
        modes.set(entry.sessionId, entry.mode)
      } else if (entry.type === 'worktree-state' && entry.sessionId) {
        worktreeStates.set(entry.sessionId, entry.worktreeSession)
      } else if (entry.type === 'pr-link' && entry.sessionId) {
        prNumbers.set(entry.sessionId, entry.prNumber)
        prUrls.set(entry.sessionId, entry.prUrl)
        prRepositories.set(entry.sessionId, entry.prRepository)
      } else if (entry.type === 'file-history-snapshot') {
        fileHistorySnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'attribution-snapshot') {
        attributionSnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'content-replacement') {
        // 子代理决策以 agentId 为键（sidechain 恢复）；主线程
        // 决策以 sessionId 为键（/resume）。
        if (entry.agentId) {
          const existing = agentContentReplacements.get(entry.agentId) ?? []
          agentContentReplacements.set(entry.agentId, existing)
          existing.push(...entry.replacements)
        } else {
          const existing = contentReplacements.get(entry.sessionId) ?? []
          contentReplacements.set(entry.sessionId, existing)
          existing.push(...entry.replacements)
        }
      } else if (entry.type === 'marble-origami-commit') {
        contextCollapseCommits.push(entry)
      } else if (entry.type === 'marble-origami-snapshot') {
        contextCollapseSnapshot = entry
      }
    }
  } catch {
    // 文件不存在或无法读取
  }

  repairBrokenParentUuidChains(messages)
  applyPreservedSegmentRelinks(messages)
  applySnipRemovals(messages)

  // 在加载时一次性计算叶子 UUID
  // 只有 user/assistant 消息应被视为锚定恢复的叶子。
  // 其他消息类型（system、attachment）是 metadata 或辅助性的，
  // 不应锚定对话链。
  //
  // 我们使用标准父关系进行主链检测，但也需要处理最后一条消息
  // 是 system/metadata 消息的情况。
  // 对于每条对话链（通过跟随父链接识别），叶子是最近的
  // user/assistant 消息。
  const allMessages = [...messages.values()]

  // 使用父关系的标准叶子计算
  const parentUuids = new Set(
    allMessages.map((msg) => msg.parentUuid).filter((uuid): uuid is UUID => uuid !== null),
  )

  // 找到所有终端消息（没有子节点的消息）
  const terminalMessages = allMessages.filter((msg) => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<UUID>()
  let hasCycle = false

  if (getFeatureValue_CACHED_MAY_BE_STALE('zy_pebble_leaf_prune', false)) {
    // 构建具有 user/assistant 子节点的 UUID 集合
    // （这些是对话中间节点，不是死胡同）
    const hasUserAssistantChild = new Set<UUID>()
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }

    // 对每个终端消息，向后遍历找到最近的 user/assistant 祖先。
    // 跳过已有 user/assistant 子节点的祖先 - 那些是对话继续的
    // 中间节点（例如，其 progress 子节点是终端的但 tool_result 子节点
    // 继续对话的 assistant tool_use 消息）。
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          if (!hasUserAssistantChild.has(current.uuid)) {
            leafUuids.add(current.uuid)
          }
          break
        }
        current = current.parentUuid ? messages.get(current.parentUuid) : undefined
      }
    }
  } else {
    // 原始叶子计算：从终端消息向后遍历无条件找到
    // 最近的 user/assistant 祖先
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          leafUuids.add(current.uuid)
          break
        }
        current = current.parentUuid ? messages.get(current.parentUuid) : undefined
      }
    }
  }

  if (hasCycle) {
    logEvent('zy_transcript_parent_cycle', {})
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    leafUuids,
  }
}

/**
 * 从特定 session 文件加载所有消息、摘要、文件历史快照和归因快照。
 */
async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}

/**
 * 获取特定 session 的消息 UUID，而无需加载所有 session。
 * 已记忆化以避免多次重读同一 session 文件。
 */
let getSessionMessages
getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

/**
 * 清除记忆化的 session 消息缓存。
 * 在压缩后调用，因为旧的消息 UUID 不再有效。
 */
export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

/**
 * 检查消息 UUID 是否存在于 session storage 中
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}

export async function getLastSessionLog(sessionId: UUID): Promise<LogOption | null> {
  // 单次读取：一次性加载所有 session 数据，而非读取文件两次
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentSettings,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  } = await loadSessionFile(sessionId)
  if (messages.size === 0) {
    return null
  }
  // 预热 getSessionMessages 缓存使 recordTranscript（在 --resume 时
  // REPL 挂载后调用）跳过第二次完整文件加载。大 session 上 -170~227ms。
  // 守卫：仅在缓存为空时预热。session 中的调用者（例如 IssueFeedback）
  // 可能对当前 session 调用 getLastSessionLog — 用过时的磁盘快照覆盖
  // 活跃缓存会丢失未 flush 的 UUID 并破坏去重。
  if (!getSessionMessages.cache.has(sessionId)) {
    getSessionMessages.cache.set(sessionId, Promise.resolve(new Set(messages.keys())))
  }

  // 找到最近的非 sidechain 消息
  const lastMessage = findLatestMessage(messages.values(), (m) => !m.isSidechain)
  if (!lastMessage) {
    return null
  }

  // 从最后一条消息构建 transcript 链
  const transcript = buildConversationChain(messages, lastMessage)

  const summary = summaries.get(lastMessage.uuid)
  const customTitle = customTitles.get(lastMessage.sessionId as UUID)
  const tag = tags.get(lastMessage.sessionId as UUID)
  const agentSetting = agentSettings.get(sessionId)
  return {
    ...convertToLogOption(
      transcript,
      0,
      summary,
      customTitle,
      buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      tag,
      getTranscriptPathForSession(sessionId),
      buildAttributionSnapshotChain(attributionSnapshots, transcript),
      agentSetting,
      contentReplacements.get(sessionId) ?? [],
    ),
    worktreeSession: worktreeStates.get(sessionId),
    contextCollapseCommits: contextCollapseCommits.filter((e) => e.sessionId === sessionId),
    contextCollapseSnapshot:
      contextCollapseSnapshot?.sessionId === sessionId ? contextCollapseSnapshot : undefined,
  }
}

/**
 * 加载消息日志列表
 * @param limit 可选的要加载的 session 文件数量限制
 * @returns 按日期排序的消息日志列表
 */
export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  // fetchLogs 返回 lite（仅 stat）日志 — 丰富它们以获取 metadata。
  // enrichLogs 已过滤掉 sidechain、空 session 等。
  const { logs: enriched } = await enrichLogs(sessionLogs, 0, sessionLogs.length)

  // enrichLogs 返回新的非共享对象 — 原地修改以避免
  // 仅为重新编号索引而重新展开每个 30 字段的 LogOption。
  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * 从所有项目目录加载消息日志。
 * @param limit 可选的每个项目要加载的 session 文件数量限制（在无索引时使用）
 * @returns 按日期排序的消息日志列表
 */
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  if (options?.skipIndex) {
    // 加载所有带完整消息数据的 session（例如用于 /insights 分析）
    return loadAllProjectsMessageLogsFull(limit)
  }
  const result = await loadAllProjectsMessageLogsProgressive(
    limit,
    options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
  )
  return result.logs
}

async function loadAllProjectsMessageLogsFull(limit?: number): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => join(projectsDir, dirent.name))

  const logsPerProject = await Promise.all(
    projectDirs.map((projectDir) => getLogsWithoutIndex(projectDir, limit)),
  )
  const allLogs = logsPerProject.flat()

  // 去重 — 同一 session+叶子可能出现在多个项目目录中。
  // 此路径每个叶子创建一个 LogOption，因此使用 sessionId+leafUuid 为键。
  const deduped = new Map<string, LogOption>()
  for (const log of allLogs) {
    const key = `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`
    const existing = deduped.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(key, log)
    }
  }

  // deduped 的值来自 getLogsWithoutIndex — 可安全修改
  const sorted = sortLogs([...deduped.values()])
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { logs: [], allStatLogs: [], nextIndex: 0 }
  }

  const projectDirs = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => join(projectsDir, dirent.name))

  const rawLogs: LogOption[] = []
  for (const projectDir of projectDirs) {
    rawLogs.push(...(await getSessionFilesLite(projectDir, limit)))
  }
  // 去重 — 同一 session 可能出现在多个项目目录中
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  // enrichLogs 返回新的非共享对象 — 可安全原地修改
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs: sorted, nextIndex }
}

/**
 * 从同一 git 仓库的所有 worktree 加载消息日志。
 * 如果未提供 worktree 则回退到 loadMessageLogs。
 *
 * 使用纯文件系统 metadata 进行快速加载。
 *
 * @param worktreePaths worktree 路径数组（来自 getWorktreePaths）
 * @param limit 可选的每个项目要加载的 session 文件数量限制
 * @returns 按日期排序的消息日志列表
 */
/**
 * 带渐进丰富支持的加载 session 日志的结果。
 */
export type SessionLogResult = {
  /** 已丰富的可供显示的日志 */
  logs: LogOption[]
  /** 用于渐进加载的完整仅 stat 列表（调用 enrichLogs 获取更多） */
  allStatLogs: LogOption[]
  /** allStatLogs 中渐进加载应继续的索引位置 */
  nextIndex: number
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const result = await loadSameRepoMessageLogsProgressive(worktreePaths, limit, initialEnrichCount)
  return result.logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  logForDebugging(
    `/resume: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/resume: found ${allStatLogs.length} session files on disk`)

  const { logs, nextIndex } = await enrichLogs(allStatLogs, 0, initialEnrichCount)

  // enrichLogs 返回新的非共享对象 — 可安全原地修改
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs, nextIndex }
}

/**
 * 获取 worktree 路径的仅 stat 日志（不读取文件）。
 */
async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    const projectDir = getProjectDir(cwd)
    return getSessionFilesLite(projectDir, undefined, cwd)
  }

  // 在 Windows 上，驱动器字母大小写可能在 git worktree list 输出
  // （例如 C:/Users/...）和路径在项目目录中的存储方式
  // （例如 c:/Users/...）之间不同。使用不区分大小写的比较。
  const caseInsensitive = process.platform === 'win32'

  // 按 sanitized 前缀长度排序 worktree 路径（最长优先），使
  // 更具体的匹配优先于较短的。否则像 -code-myrepo 这样的短前缀
  // 可能在更长、更具体的前缀有机会之前匹配到 -code-myrepo-worktree1。
  const indexed = worktreePaths.map((wt) => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  const allLogs: LogOption[] = []
  const seenDirs = new Set<string>()

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (e) {
    // 回退到当前项目
    logForDebugging(
      `Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`,
    )
    const projectDir = getProjectDir(getOriginalCwd())
    return getSessionFilesLite(projectDir, limit, getOriginalCwd())
  }

  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) {
      continue
    }
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) {
      continue
    }

    for (const { path: wtPath, prefix } of indexed) {
      if (dirName === prefix || dirName.startsWith(`${prefix}-`)) {
        seenDirs.add(dirName)
        allLogs.push(
          ...(await getSessionFilesLite(join(projectsDir, dirent.name), undefined, wtPath)),
        )
        break
      }
    }
  }

  // 按 sessionId 去重 — 同一 session 可能出现在多个 worktree
  // 项目目录中。保留修改时间最新的条目。
  return deduplicateLogsBySessionId(allLogs)
}

/**
 * 通过 agentId 检索特定代理的 transcript。
 * 直接加载代理特定的 transcript 文件。
 * @param agentId 要搜索的代理 ID
 * @returns 代理的对话链和预算替换记录，
 *          如果未找到则返回 null
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)

  try {
    const { messages, agentContentReplacements } = await loadTranscriptFile(agentFile)

    // 找到匹配 agentId 的消息
    const agentMessages = Array.from(messages.values()).filter(
      (msg) => msg.agentId === agentId && msg.isSidechain,
    )

    if (agentMessages.length === 0) {
      return null
    }

    // 找到此 agentId 的最近叶子消息
    const parentUuids = new Set(agentMessages.map((msg) => msg.parentUuid))
    const leafMessage = findLatestMessage(agentMessages, (msg) => !parentUuids.has(msg.uuid))

    if (!leafMessage) {
      return null
    }

    // 构建对话链
    const transcript = buildConversationChain(messages, leafMessage)

    // 过滤为仅包含此 agentId 的消息
    const agentTranscript = transcript.filter((msg) => msg.agentId === agentId)

    return {
      // 将 TranscriptMessage[] 转换为 Message[]
      messages: agentTranscript.map(({ isSidechain, parentUuid, ...msg }) => msg),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

/**
 * 从对话中的 progress 消息中提取代理 ID。
 * 代理/skill progress 消息的 type 为 'progress'，data.type
 * 为 'agent_progress' 或 'skill_progress'，且有 data.agentId。
 * 这捕获了执行期间发出 progress 消息的同步代理。
 */
export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const agentIds: string[] = []

  for (const message of messages) {
    if (
      message.type === 'progress' &&
      message.data &&
      typeof message.data === 'object' &&
      'type' in message.data &&
      (message.data.type === 'agent_progress' || message.data.type === 'skill_progress') &&
      'agentId' in message.data &&
      typeof message.data.agentId === 'string'
    ) {
      agentIds.push(message.data.agentId)
    }
  }

  return uniq(agentIds)
}

/**
 * 直接从 AppState 任务中提取队友 transcript。
 * 进程内队友将其消息存储在 task.messages 中，
 * 这比从磁盘加载更可靠，因为每个队友轮次使用
 * 随机 agentId 进行 transcript 存储。
 */
export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

/**
 * 为给定的代理 ID 加载子代理 transcript
 */
export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const results = await Promise.all(
    agentIds.map(async (agentId) => {
      try {
        const result = await getAgentTranscript(asAgentId(agentId))
        if (result && result.messages.length > 0) {
          return { agentId, transcript: result.messages }
        }
        return null
      } catch {
        // 如果 transcript 无法加载则跳过
        return null
      }
    }),
  )

  const transcripts: { [agentId: string]: Message[] } = {}
  for (const result of results) {
    if (result) {
      transcripts[result.agentId] = result.transcript
    }
  }
  return transcripts
}

// 直接 glob session 的 subagents 目录 — 与 AppState.tasks 不同，这在任务驱逐后仍存活。
export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const subagentsDir = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    getSessionId(),
    'subagents',
  )
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return {}
  }
  // 文件名格式是 getAgentTranscriptPath() 的逆 — 保持同步。
  const agentIds = entries
    .filter((d) => d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'))
    .map((d) => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

// 导出以便 useLogMessages 可以同步计算最后一个可记录的 uuid，
// 而无需 await recordTranscript 的返回值（无竞争的提示跟踪）。
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') {
    return false
  }
  // 重要：我们故意为非 ant 用户过滤掉大多数 attachment，因为
  // 它们包含不想公开的训练敏感信息。
  // 启用时，我们允许 hook_additional_context 通过，因为它包含
  // 用户配置的 hook 输出，对恢复时的 session 上下文有用。
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    if (
      m.attachment.type === 'hook_additional_context' &&
      isEnvTruthy(process.env.ZY_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    return false
  }
  return true
}

function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_call' && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
  return ids
}

/**
 * 对于外部用户，使 REPL 在持久化的 transcript 中不可见：剥离
 * REPL tool_use/tool_result 对并将 isVirtual 消息提升为真实消息。
 * 在 --resume 时模型看到连贯的原生工具调用历史（assistant
 * 调用 Bash，得到结果，调用 Read，得到结果）而没有 REPL 包装器。
 * ant transcript 保留包装器以便 /share 训练数据看到 REPL 使用。
 *
 * replIds 从完整 session 数组预收集，而非正在转换的切片 —
 * recordTranscript 接收增量切片，其中 REPL tool_use（较早渲染）
 * 和其 tool_result（较晚渲染，异步执行后）落在不同调用中。
 * 每次调用新建的 Set 会遗漏 id 并在磁盘上留下孤立的 tool_result。
 */
function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap((m) => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some((b) => b.type === 'tool_call' && b.name === REPL_TOOL_NAME)
      const filtered = hasRepl
        ? content.filter((b) => !(b.type === 'tool_call' && b.name === REPL_TOOL_NAME))
        : content
      if (filtered.length === 0) {
        return []
      }
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some((b) => b.type === 'tool_result' && replIds.has(b.toolCallId))
      const filtered = hasRepl
        ? content.filter((b) => !(b.type === 'tool_result' && replIds.has(b.toolCallId)))
        : content
      if (filtered.length === 0) {
        return []
      }
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    // 字符串内容的 user、system、attachment
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(filtered, collectReplIds(allMessages))
    : filtered
}

/**
 * 通过索引获取日志
 * @param index 排序后的日志列表中的索引（0 基）
 * @returns 日志数据，如果未找到则返回 null
 */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * 通过 tool_use_id 在 transcript 中查找未解析的工具使用。
 * 返回包含 tool_use 的 assistant 消息，如果未找到
 * 或该工具调用已有 tool_result 则返回 null。
 */
export async function findUnresolvedToolUse(toolUseId: string): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    // 找到工具使用但确保没有对应的结果
    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_call' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.toolCallId === toolUseId) {
              // 找到工具结果，退出
              return null
            }
          }
        }
      }
    }

    return toolUseMessage
  } catch {
    return null
  }
}

/**
 * 获取项目目录中所有 session JSONL 文件及其 stat。
 * 返回 sessionId → {path, mtime, ctime, size} 的 map。
 * stat 通过 Promise.all 批量执行以避免热循环中的串行系统调用。
 */
export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<Map<string, { path: string; mtime: number; ctime: number; size: number }>> {
  const sessionFilesMap = new Map<
    string,
    { path: string; mtime: number; ctime: number; size: number }
  >()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    // 目录不存在 - 返回空 map
    return sessionFilesMap
  }

  const candidates: Array<{ sessionId: string; filePath: string }> = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) {
      continue
    }
    const sessionId = validateUuid(basename(dirent.name, '.jsonl'))
    if (!sessionId) {
      continue
    }
    candidates.push({ sessionId, filePath: join(projectDir, dirent.name) })
  }

  await Promise.all(
    candidates.map(async ({ sessionId, filePath }) => {
      try {
        const st = await stat(filePath)
        sessionFilesMap.set(sessionId, {
          path: filePath,
          mtime: st.mtime.getTime(),
          ctime: st.birthtime.getTime(),
          size: st.size,
        })
      } catch {
        logForDebugging(`Failed to stat session file: ${filePath}`)
      }
    }),
  )

  return sessionFilesMap
}

/**
 * 恢复选择器初始加载时要丰富的 session 数量。
 * 每次丰富读取每个文件最多 128 KB（头部 + 尾部），因此 50 个 session
 * 意味着 ~6.4 MB I/O — 在任何现代文件系统上都很快，同时给用户
 * 比之前默认的 10 更好的初始视图。
 */
let INITIAL_ENRICH_COUNT
INITIAL_ENRICH_COUNT = 50

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

/**
 * 从单个 session 文件加载所有带完整消息数据的日志。
 * 为文件中的每个叶子消息构建一个 LogOption。
 */
export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    leafUuids,
  } = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })

  if (messages.size === 0) {
    return []
  }

  const leafMessages: TranscriptMessage[] = []
  // 构建一次 parentUuid → children 索引（O(n)），使每个叶子的尾部消息查找为 O(1)
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (leafUuids.has(msg.uuid)) {
      leafMessages.push(msg)
    } else if (msg.parentUuid) {
      const siblings = childrenByParent.get(msg.parentUuid)
      if (siblings) {
        siblings.push(msg)
      } else {
        childrenByParent.set(msg.parentUuid, [msg])
      }
    }
  }

  const logs: LogOption[] = []

  for (const leafMessage of leafMessages) {
    const chain = buildConversationChain(messages, leafMessage)
    if (chain.length === 0) {
      continue
    }

    // 追加叶子的子消息作为尾部消息
    const trailingMessages = childrenByParent.get(leafMessage.uuid)
    if (trailingMessages) {
      // ISO-8601 UTC 时间戳可按字典序排序
      trailingMessages.sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      )
      chain.push(...trailingMessages)
    }

    const firstMessage = chain[0]!
    const sessionId = leafMessage.sessionId as UUID

    logs.push({
      date: leafMessage.timestamp,
      messages: removeExtraFields(chain),
      fullPath: sessionFile,
      value: 0,
      created: new Date(firstMessage.timestamp),
      modified: new Date(leafMessage.timestamp),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: countVisibleMessages(chain),
      isSidechain: firstMessage.isSidechain ?? false,
      sessionId,
      leafUuid: leafMessage.uuid,
      summary: summaries.get(leafMessage.uuid),
      customTitle: customTitles.get(sessionId),
      tag: tags.get(sessionId),
      agentName: agentNames.get(sessionId),
      agentColor: agentColors.get(sessionId),
      agentSetting: agentSettings.get(sessionId),
      mode: modes.get(sessionId) as LogOption['mode'],
      prNumber: prNumbers.get(sessionId),
      prUrl: prUrls.get(sessionId),
      prRepository: prRepositories.get(sessionId),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      fileHistorySnapshots: buildFileHistorySnapshotChain(fileHistorySnapshots, chain),
      attributionSnapshots: buildAttributionSnapshotChain(attributionSnapshots, chain),
      contentReplacements: contentReplacements.get(sessionId) ?? [],
    })
  }

  return logs
}

/**
 * 通过完整加载所有 session 文件获取日志，绕过 session 索引。
 * 当需要完整消息数据时使用（例如用于 /insights 分析）。

 */
async function getLogsWithoutIndex(projectDir: string, limit?: number): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)
  if (sessionFilesMap.size === 0) {
    return []
  }

  // 如果指定了限制，仅按 mtime 加载最近的 N 个文件
  let filesToProcess: Array<{ path: string; mtime: number }>
  if (limit && sessionFilesMap.size > limit) {
    filesToProcess = [...sessionFilesMap.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit)
  } else {
    filesToProcess = [...sessionFilesMap.values()]
  }

  const logs: LogOption[] = []
  for (const fileInfo of filesToProcess) {
    try {
      const fileLogOptions = await loadAllLogsFromSessionFile(fileInfo.path)
      logs.push(...fileLogOptions)
    } catch {
      logForDebugging(`Failed to load session file: ${fileInfo.path}`)
    }
  }

  return logs
}

/**
 * 读取 JSONL 文件的前后各 ~64KB 并提取 lite metadata。
 *
 * 头部（前 64KB）：isSidechain、projectPath、teamName、firstPrompt。
 * 尾部（后 64KB）：customTitle、tag、PR 链接、最新 gitBranch。
 *
 * 接受共享缓冲区以避免每文件的分配开销。
 */
async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  if (!head) {
    return { firstPrompt: '', isSidechain: false }
  }

  // 通过字符串搜索从首行提取稳定 metadata。
  // 即使首行被截断（>64KB 消息）也有效。
  const isSidechain = head.includes('"isSidechain":true') || head.includes('"isSidechain": true')
  const projectPath = extractJsonStringField(head, 'cwd')
  const teamName = extractJsonStringField(head, 'teamName')
  const agentSetting = extractJsonStringField(head, 'agentSetting')

  // 优先使用 last-prompt 尾部 entry — 在写入时由 extractFirstPrompt
  // 捕获（已过滤，权威性），显示用户最近在做什么。头部扫描是
  // last-prompt entry 存在之前写入的 session 的回退。头部的
  // 原始字符串抓取是最后手段，用于捕获数组格式内容块
  // （VS Code <ide_selection> metadata）。
  const firstPrompt =
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractFirstPromptFromChunk(head) ||
    extractJsonStringFieldPrefix(head, 'content', 200) ||
    extractJsonStringFieldPrefix(head, 'text', 200) ||
    ''

  // 通过字符串搜索提取尾部 metadata（最后出现的优先）。
  // 用户标题（customTitle 字段，来自 custom-title entry）优先于
  // AI 标题（aiTitle 字段，来自 ai-title entry）。不同的字段名
  // 意味着 extractLastJsonStringField 自然消除歧义。
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ?? extractJsonStringField(head, 'gitBranch')

  // PR 链接字段 — prNumber 是数字而非字符串，因此两种方式都尝试
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumStr = extractLastJsonStringField(tail, 'prNumber')
  if (prNumStr) {
    prNumber = parseInt(prNumStr, 10) || undefined
  }
  if (!prNumber) {
    const prNumMatch = tail.lastIndexOf('"prNumber":')
    if (prNumMatch >= 0) {
      const afterColon = tail.slice(prNumMatch + 11, prNumMatch + 25)
      const num = parseInt(afterColon.trim(), 10)
      if (num > 0) {
        prNumber = num
      }
    }
  }

  return {
    firstPrompt,
    gitBranch,
    isSidechain,
    projectPath,
    teamName,
    customTitle,
    summary,
    tag,
    agentSetting,
    prNumber,
    prUrl,
    prRepository,
  }
}

/**
 * 扫描一段文本以找到首条有意义的用户 prompt。
 */
function extractFirstPromptFromChunk(chunk: string): string {
  let start = 0
  let hasTickMessages = false
  let firstCommandFallback = ''
  while (start < chunk.length) {
    const newlineIdx = chunk.indexOf('\n', start)
    const line = newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (line.includes('"tool_result"')) {
      continue
    }
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) {
      continue
    }

    try {
      const entry = jsonParse(line) as Record<string, unknown>
      if (entry.type !== 'user') {
        continue
      }

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) {
        continue
      }

      const content = message.content
      // 从消息内容中收集所有文本值。对于数组内容
      // （在 VS Code 中常见，其中 IDE metadata 标签在用户实际 prompt 之前），
      // 遍历所有文本块以免遗漏隐藏在 <ide_selection>/<ide_opened_file>
      // 块后面的真实 prompt。
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text as string)
          }
        }
      }

      for (const text of texts) {
        if (!text) {
          continue
        }

        let result = text.replace(/\n/g, ' ').trim()

        // 跳过命令消息（斜杠命令）但记住第一个作为回退标题。
        // 匹配 getFirstMeaningfulUserMessageTextContent 中的跳过逻辑，
        // 但不完全丢弃命令消息，而是清晰格式化它们（例如 "/clear"），
        // 使 session 仍出现在恢复选择器中。
        const commandNameTag = extractTag(result, COMMAND_NAME_TAG)
        if (commandNameTag) {
          const name = commandNameTag.replace(/^\//, '')
          const commandArgs = extractTag(result, 'command-args')?.trim() || ''
          if (builtInCommandNames().has(name) || !commandArgs) {
            if (!firstCommandFallback) {
              firstCommandFallback = commandNameTag
            }
            continue
          }
          // 有意义参数的自定义命令 — 使用清晰显示
          return commandArgs ? `${commandNameTag} ${commandArgs}` : commandNameTag
        }

        // 在通用 XML 跳过之前以 ! 前缀格式化 bash 输入
        const bashInput = extractTag(result, 'bash-input')
        if (bashInput) {
          return `! ${bashInput}`
        }

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          if ((feature('PROACTIVE') || feature('KAIROS')) && result.startsWith(`<${TICK_TAG}>`)) {
            hasTickMessages = true
          }
          continue
        }
        if (result.length > 200) {
          result = `${result.slice(0, 200).trim()}…`
        }
        return result
      }
    } catch {}
  }
  // session 以斜杠命令开始但没有后续真实消息 —
  // 使用清晰的命令名称使 session 仍出现在恢复选择器中
  if (firstCommandFallback) {
    return firstCommandFallback
  }
  // 主动式 session 只有 tick 消息 — 给它们一个合成的 prompt
  // 以免被 enrichLogs 过滤掉
  if ((feature('PROACTIVE') || feature('KAIROS')) && hasTickMessages) {
    return 'Proactive session'
  }
  return ''
}

/**
 * 类似 extractJsonStringField 但即使缺少闭合引号（截断的缓冲区）也返回
 * 值的前 `maxLen` 个字符。换行转义被替换为空格，结果被修剪。
 */
function extractJsonStringFieldPrefix(text: string, key: string, maxLen: number): string {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) {
      continue
    }

    const valueStart = idx + pattern.length
    // 从值中获取最多 maxLen 个字符，在闭合引号处停止
    let i = valueStart
    let collected = 0
    while (i < text.length && collected < maxLen) {
      if (text[i] === '\\') {
        i += 2 // skip escaped char
        collected++
        continue
      }
      if (text[i] === '"') {
        break
      }
      i++
      collected++
    }
    const raw = text.slice(valueStart, i)
    return raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').trim()
  }
  return ''
}

/**
 * 按 sessionId 去重日志，保留修改时间最新的条目。
 * 返回带有顺序值索引的排序日志。
 */
function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const deduped = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) {
      continue
    }
    const existing = deduped.get(log.sessionId)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(log.sessionId, log)
    }
  }
  return sortLogs([...deduped.values()]).map((log, i) => ({
    ...log,
    value: i,
  }))
}

/**
 * 从纯文件系统 metadata（仅 stat）返回 lite LogOption[]。
 * 不读取文件 — 即时。调用 `enrichLogs` 以使用
 * firstPrompt、gitBranch、customTitle 等丰富可见 session。
 */
export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)

  // 按 mtime 降序排序并应用限制
  let entries = [...sessionFilesMap.entries()].sort((a, b) => b[1].mtime - a[1].mtime)
  if (limit && entries.length > limit) {
    entries = entries.slice(0, limit)
  }

  const logs: LogOption[] = []

  for (const [sessionId, fileInfo] of entries) {
    logs.push({
      date: new Date(fileInfo.mtime).toISOString(),
      messages: [],
      isLite: true,
      fullPath: fileInfo.path,
      value: 0,
      created: new Date(fileInfo.ctime),
      modified: new Date(fileInfo.mtime),
      firstPrompt: '',
      messageCount: 0,
      fileSize: fileInfo.size,
      isSidechain: false,
      sessionId,
      projectPath,
    })
  }

  // 日志刚在上面 push — 可安全原地修改
  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * 使用 JSONL 文件中的 metadata 丰富 lite 日志。
 * 返回丰富后的日志，如果日志无有意义内容则返回 null
 * （无 firstPrompt、无 customTitle — 例如仅含 metadata 的 session 文件）。
 */
async function enrichLog(log: LogOption, readBuf: Buffer): Promise<LogOption | null> {
  if (!log.isLite || !log.fullPath) {
    return log
  }

  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)

  const enriched: LogOption = {
    ...log,
    isLite: false,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    isSidechain: meta.isSidechain,
    teamName: meta.teamName,
    customTitle: meta.customTitle,
    summary: meta.summary,
    tag: meta.tag,
    agentSetting: meta.agentSetting,
    prNumber: meta.prNumber,
    prUrl: meta.prUrl,
    prRepository: meta.prRepository,
    projectPath: meta.projectPath ?? log.projectPath,
  }

  // 为无法提取首条 prompt 的 session 提供回退标题
  // （例如超过 16KB 读取缓冲区的大型首条消息）。
  // 以前这些 session 会被静默丢弃，使其在崩溃或
  // 大上下文 session 后通过 /resume 无法访问。
  if (!enriched.firstPrompt && !enriched.customTitle) {
    enriched.firstPrompt = '(session)'
  }
  // 过滤：跳过 sidechain 和代理 session
  if (enriched.isSidechain) {
    logForDebugging(`Session ${log.sessionId} filtered from /resume: isSidechain=true`)
    return null
  }
  if (enriched.teamName) {
    logForDebugging(`Session ${log.sessionId} filtered from /resume: teamName=${enriched.teamName}`)
    return null
  }

  return enriched
}

/**
 * 从 `allLogs`（从 `startIndex` 开始）丰富足够的 lite 日志以
 * 产生 `count` 个有效结果。返回有效的丰富日志和
 * 扫描停止的索引（用于渐进加载继续）。
 */
export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  const result: LogOption[] = []
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  let i = startIndex

  while (i < allLogs.length && result.length < count) {
    const log = allLogs[i]!
    i++

    const enriched = await enrichLog(log, readBuf)
    if (enriched) {
      result.push(enriched)
    }
  }

  const scanned = i - startIndex
  const filtered = scanned - result.length
  if (filtered > 0) {
    logForDebugging(
      `/resume: enriched ${scanned} sessions, ${filtered} filtered out, ${result.length} visible (${allLogs.length - i} remaining on disk)`,
    )
  }

  return { logs: result, nextIndex: i }
}
