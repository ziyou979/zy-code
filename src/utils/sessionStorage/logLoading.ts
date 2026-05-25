// 从磁盘加载 transcript / metadata：包含 JSONL 解析、UUID 链修复、
// session 列表枚举、subagent 子链加载等所有读路径。
// 写路径（recordTranscript / flushSessionStorage）和 Project 单例仍在 sessionStorage.ts。

import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG, TICK_TAG } from '../../constants/xml.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { type AgentId, asAgentId } from '../../types/ids.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import {
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type LogOption,
  type PersistedWorktreeSession,
  sortLogs,
  type TranscriptMessage,
} from '../../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { getWorktreePaths } from '../getWorktreePaths.js'
import { parseJSONL } from '../json.js'
import { extractTag, isCompactBoundaryMessage } from '../messages.js'
import { sanitizePath } from '../path.js'
import { getUserType } from '../sessionStorage/env.js'
import { isLegacyProgressEntry, isTranscriptMessage } from '../sessionStorage/predicates.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../sessionStoragePortable.js'
import { jsonParse } from '../slowOperations.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { validateUuid } from '../uuid.js'

type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

/**
 * enrichLogs 的初始批数：50（比之前默认 10 更好的初始视图）。
 */
const INITIAL_ENRICH_COUNT = 50

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

// 跟 chain.ts:SKIP_FIRST_PROMPT_PATTERN 保持同步 — 镜像本地副本，避免循环 export 依赖。
const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildAttributionSnapshotChain,
  buildConversationChain,
  buildFileHistorySnapshotChain,
  countVisibleMessages,
  extractFirstPrompt,
  findLatestMessage,
  removeExtraFields,
} from '../sessionStorage/chain.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from '../sessionStorage/paths.js'

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
export const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

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
    leafUuid: lastMessage.uuid as UUID,
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
      leafUuid: (mostRecentLeaf?.uuid ?? log.leafUuid) as UUID,
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
  const sessionIdToLog = new Map<string, LogOption>()
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
export function repairBrokenParentUuidChains(messages: Map<string, TranscriptMessage>): void {
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
        msg.parentUuid = group[i - 1]!.uuid as UUID
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
  messages: Map<string, TranscriptMessage>
  summaries: Map<string, string>
  customTitles: Map<string, string>
  tags: Map<string, string>
  agentNames: Map<string, string>
  agentColors: Map<string, string>
  agentSettings: Map<string, string>
  prNumbers: Map<string, number>
  prUrls: Map<string, string>
  prRepositories: Map<string, string>
  modes: Map<string, string>
  worktreeStates: Map<string, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<string, FileHistorySnapshotMessage>
  attributionSnapshots: Map<string, AttributionSnapshotMessage>
  contentReplacements: Map<string, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<string>
}> {
  const messages = new Map<string, TranscriptMessage>()
  const summaries = new Map<string, string>()
  const customTitles = new Map<string, string>()
  const tags = new Map<string, string>()
  const agentNames = new Map<string, string>()
  const agentColors = new Map<string, string>()
  const agentSettings = new Map<string, string>()
  const prNumbers = new Map<string, number>()
  const prUrls = new Map<string, string>()
  const prRepositories = new Map<string, string>()
  const modes = new Map<string, string>()
  const worktreeStates = new Map<string, PersistedWorktreeSession | null>()
  const fileHistorySnapshots = new Map<string, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<string, AttributionSnapshotMessage>()
  const contentReplacements = new Map<string, ContentReplacementRecord[]>()
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
    const progressBridge = new Map<string, UUID | null>()

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
  const parentUuids = new Set<string>(
    allMessages.map((msg) => msg.parentUuid).filter((uuid): uuid is UUID => uuid !== null),
  )

  // 找到所有终端消息（没有子节点的消息）
  const terminalMessages = allMessages.filter((msg) => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<string>()
  let hasCycle = false

  if (getFeatureValue_CACHED_MAY_BE_STALE('zy_pebble_leaf_prune', false)) {
    // 构建具有 user/assistant 子节点的 UUID 集合
    // （这些是对话中间节点，不是死胡同）
    const hasUserAssistantChild = new Set<string>()
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
      const seen = new Set<string>()
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
      const seen = new Set<string>()
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
export async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<string, TranscriptMessage>
  summaries: Map<string, string>
  customTitles: Map<string, string>
  tags: Map<string, string>
  agentSettings: Map<string, string>
  worktreeStates: Map<string, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<string, FileHistorySnapshotMessage>
  attributionSnapshots: Map<string, AttributionSnapshotMessage>
  contentReplacements: Map<string, ContentReplacementRecord[]>
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
export let getSessionMessages: ReturnType<typeof memoize<(sessionId: UUID) => Promise<Set<string>>>>
getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<string>> => {
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
    const parentUuids = new Set<string | null>(agentMessages.map((msg) => msg.parentUuid))
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
  const childrenByParent = new Map<string, TranscriptMessage[]>()
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
      leafUuid: leafMessage.uuid as UUID,
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
