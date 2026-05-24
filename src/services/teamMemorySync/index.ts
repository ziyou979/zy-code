/**
 * 团队记忆同步服务
 *
 * 在本地文件系统与服务器 API 之间同步团队记忆文件。
 * 团队记忆以仓库为单位（通过 git remote hash 标识），在同一组织的所有认证成员间共享。
 *
 * API 契约（anthropic/anthropic#250711 + #283027）：
 *   GET  /api/claude_code/team_memory?repo={owner/repo}            → TeamMemoryData（包含 entryChecksums）
 *   GET  /api/claude_code/team_memory?repo={owner/repo}&view=hashes → 仅 metadata + entryChecksums（不含条目内容）
 *   PUT  /api/claude_code/team_memory?repo={owner/repo}            → 上传条目（upsert 语义）
 *   404 = 尚不存在数据
 *
 * 同步语义：
 *   - Pull 会用服务器内容覆盖本地文件（按 key 服务器优先）。
 *   - Push 仅上传内容哈希与 serverChecksums 不同的 key（增量上传）。
 *     服务器使用 upsert：PUT 中未包含的 key 会被保留。
 *   - 本地文件删除不会传播到服务器：删除本地文件不会从服务器移除，
 *     下次 pull 会重新恢复到本地。
 *
 * 状态管理：
 *   所有可变状态（ETag 跟踪、watcher 抑制）都存储在调用方创建并贯穿所有调用的
 *   SyncState 对象中。这避免了模块级可变状态，并为测试提供天然的隔离性。
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import axios from 'axios'
import {
  getOauthConfig,
  OAUTH_BETA_HEADER,
  ZY_CODE_INFERENCE_SCOPE,
  ZY_CODE_PROFILE_SCOPE,
} from '../../constants/oauth.js'
import {
  getTeamMemPath,
  PathTraversalError,
  validateTeamMemKey,
} from '../../memdir/teamMemPaths.js'
import { count } from '../../utils/array.js'
import { checkAndRefreshOAuthTokenIfNeeded, getZyAIOAuthTokens } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { classifyAxiosError } from '../../utils/errors.js'
import { getGithubRepo } from '../../utils/git.js'
import { getAPIProvider, isAnthropicBaseUrl } from '../../services/model/providers.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getZyCodeUserAgent } from '../../utils/userAgent.js'
import { logEvent } from '../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import { getRetryDelay } from '../api/withRetry.js'
import { scanForSecrets } from './secretScanner.js'
import {
  type SkippedSecretFile,
  TeamMemoryDataSchema,
  type TeamMemoryHashesResult,
  type TeamMemorySyncFetchResult,
  type TeamMemorySyncPushResult,
  type TeamMemorySyncUploadResult,
  TeamMemoryTooManyEntriesSchema,
} from './types.js'

const TEAM_MEMORY_SYNC_TIMEOUT_MS = 30_000
// 每个条目的大小上限 —— 来自 anthropic/anthropic#293258 的服务器默认值。
// 预先过滤过大的条目可以节省带宽：此情况下的结构化 413 错误
// 不会提供额外信息（只是一个文件太大了）。
const MAX_FILE_SIZE_BYTES = 250_000
// 客户端不设置 DEFAULT_MAX_ENTRIES：服务器的条目数量上限
// 可按组织进行 GB 级别调整（claude_code_team_memory_limits），因此任何编译时
// 常量都会过时。只有在收到结构化 413 的 extra_details.max_entries 后才会截断。
// API 网关的 body 大小上限。API 网关会在请求到达应用服务器之前，
// 用非结构化（HTML）413 拒绝超过 ~256-512KB 的 PUT body ——
// 仅能通过延迟时间（网关约 ~750ms，应用服务器约 ~2.3s）
// 与应用的条目数量 413 区分。#21969 移除了客户端条目数量上限；
// 重度用户的冷推送会发送 300KB-1.4MB 的 body 并触发此限制。
// 200KB 在观察到的阈值之下留有余量，
// 并使单个 MAX_FILE_SIZE_BYTES 的独立批处理（~250KB）
// 刚好低于实际网关限制。超过此大小的批处理会被拆分为
// 顺序 PUT —— 服务器的 upsert-merge 语义使其是安全的。
const MAX_PUT_BODY_BYTES = 200_000
const MAX_RETRIES = 3
const MAX_CONFLICT_RETRIES = 2

// ─── 同步状态 ─────────────────────────────────────────────

/**
 * 团队记忆同步服务的可变状态。
 * 由 watcher 在每个会话中创建一次，并传递给所有同步函数。
 * 测试为每个测试创建新实例以实现隔离。
 */
export type SyncState = {
  /** 用于条件请求的最后已知服务器校验和（ETag）。 */
  lastKnownChecksum: string | null
  /**
   * 我们认定的服务器当前持有的每个 key 的内容哈希（`sha256:<hex>`）。
   * 在 pull 时从服务器提供的 entryChecksums 填充，
   * 在 push 成功后从本地哈希填充。用于在 push 时计算增量 ——
   * 仅上传本地哈希不同的 key。
   */
  serverChecksums: Map<string, string>
  /**
   * 服务器强制的 max_entries 上限，从结构化 413 响应中学习得到
   * （anthropic/anthropic#293258 添加了 error_code + extra_details.max_entries）。
   * 在观察到 413 之前保持为 null —— 服务器的上限可按组织进行 GB 级别调整，
   * 因此没有正确的客户端默认值。当为 null 时，
   * readLocalTeamMemory 会发送所有内容，让服务器拥有
   * 最终决定权（它会原子性地拒绝）。
   */
  serverMaxEntries: number | null
}

export function createSyncState(): SyncState {
  return {
    lastKnownChecksum: null,
    serverChecksums: new Map(),
    serverMaxEntries: null,
  }
}

/**
 * 对给定内容的 UTF-8 字节计算 `sha256:<hex>`。
 * 格式与服务器的 entryChecksums 值匹配（anthropic/anthropic#283027），
 * 因此本地与服务器的比较可以通过直接字符串相等来完成。
 */
export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

/**
 * 类型守卫，将未知 error 收窄为 Node.js 的 errno 风格异常。
 * 使用 `in` 收窄，因此调用处不需要 `as` 转换。
 */
function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e && typeof e.code === 'string'
}

// ─── 认证与端点 ─────────────────────────────────────────

/**
 * 检查用户是否已使用 ZY OAuth 认证（团队记忆同步的必要条件）。
 */
function isUsingOAuth(): boolean {
  if (getAPIProvider() !== 'anthropic' || !isAnthropicBaseUrl()) {
    return false
  }
  const tokens = getZyAIOAuthTokens()
  return Boolean(
    tokens?.accessToken &&
      tokens.scopes?.includes(ZY_CODE_INFERENCE_SCOPE) &&
      tokens.scopes.includes(ZY_CODE_PROFILE_SCOPE),
  )
}

function getTeamMemorySyncEndpoint(repoSlug: string): string {
  const baseUrl = process.env.TEAM_MEMORY_SYNC_URL || getOauthConfig().BASE_API_URL
  return `${baseUrl}/api/claude_code/team_memory?repo=${encodeURIComponent(repoSlug)}`
}

function getAuthHeaders(): {
  headers?: Record<string, string>
  error?: string
} {
  const oauthTokens = getZyAIOAuthTokens()
  if (oauthTokens?.accessToken) {
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': getZyCodeUserAgent(),
      },
    }
  }
  return { error: 'No OAuth token available for team memory sync' }
}

// ─── 拉取（fetch） ────────────────────────────────────────────

async function fetchTeamMemoryOnce(
  state: SyncState,
  repoSlug: string,
  etag?: string | null,
): Promise<TeamMemorySyncFetchResult> {
  try {
    await checkAndRefreshOAuthTokenIfNeeded()

    const auth = getAuthHeaders()
    if (auth.error) {
      return {
        success: false,
        error: auth.error,
        skipRetry: true,
        errorType: 'auth',
      }
    }

    const headers: Record<string, string> = { ...auth.headers }
    if (etag) {
      headers['If-None-Match'] = `"${etag.replace(/"/g, '')}"`
    }

    const endpoint = getTeamMemorySyncEndpoint(repoSlug)
    const response = await axios.get(endpoint, {
      headers,
      timeout: TEAM_MEMORY_SYNC_TIMEOUT_MS,
      validateStatus: (status) => status === 200 || status === 304 || status === 404,
    })

    if (response.status === 304) {
      logForDebugging('team-memory-sync: not modified (304)', {
        level: 'debug',
      })
      return { success: true, notModified: true, checksum: etag ?? undefined }
    }

    if (response.status === 404) {
      logForDebugging('team-memory-sync: no remote data (404)', {
        level: 'debug',
      })
      state.lastKnownChecksum = null
      return { success: true, isEmpty: true }
    }

    const parsed = TeamMemoryDataSchema().safeParse(response.data)
    if (!parsed.success) {
      logForDebugging('team-memory-sync: invalid response format', {
        level: 'warn',
      })
      return {
        success: false,
        error: 'Invalid team memory response format',
        skipRetry: true,
        errorType: 'parse',
      }
    }

    // 从响应数据或 ETag 头中提取校验和
    const responseChecksum =
      parsed.data.checksum || response.headers.etag?.replace(/^"|"$/g, '') || undefined
    if (responseChecksum) {
      state.lastKnownChecksum = responseChecksum
    }

    logForDebugging(
      `team-memory-sync: fetched successfully (checksum: ${responseChecksum ?? 'none'})`,
      { level: 'debug' },
    )
    return {
      success: true,
      data: parsed.data,
      isEmpty: false,
      checksum: responseChecksum,
    }
  } catch (error) {
    const { kind, status, message } = classifyAxiosError(error)
    const body = axios.isAxiosError(error) ? JSON.stringify(error.response?.data ?? '') : ''
    if (kind !== 'other') {
      logForDebugging(`team-memory-sync: fetch error ${status}: ${body}`, {
        level: 'warn',
      })
    }
    switch (kind) {
      case 'auth':
        return {
          success: false,
          error: `Not authorized for team memory sync: ${body}`,
          skipRetry: true,
          errorType: 'auth',
          httpStatus: status,
        }
      case 'timeout':
        return {
          success: false,
          error: 'Team memory sync request timeout',
          errorType: 'timeout',
        }
      case 'network':
        return {
          success: false,
          error: 'Cannot connect to server',
          errorType: 'network',
        }
      default:
        return {
          success: false,
          error: message,
          errorType: 'unknown',
          httpStatus: status,
        }
    }
  }
}

/**
 * 仅获取每个 key 的校验和 + 元数据（不含条目内容）。
 * 用于 412 冲突解决期间廉价刷新 serverChecksums —— 避免
 * 为了知道哪些 key 发生变化而下载 ~300KB 的内容。
 * 需要 anthropic/anthropic#283027 已部署；失败时调用方会
 * 使 push 失败，watcher 会在下次编辑时重试。
 */
async function fetchTeamMemoryHashes(
  state: SyncState,
  repoSlug: string,
): Promise<TeamMemoryHashesResult> {
  try {
    await checkAndRefreshOAuthTokenIfNeeded()
    const auth = getAuthHeaders()
    if (auth.error) {
      return { success: false, error: auth.error, errorType: 'auth' }
    }

    const endpoint = `${getTeamMemorySyncEndpoint(repoSlug)}&view=hashes`
    const response = await axios.get(endpoint, {
      headers: auth.headers,
      timeout: TEAM_MEMORY_SYNC_TIMEOUT_MS,
      validateStatus: (status) => status === 200 || status === 404,
    })

    if (response.status === 404) {
      state.lastKnownChecksum = null
      return { success: true, entryChecksums: {} }
    }

    const checksum = response.data?.checksum || response.headers.etag?.replace(/^"|"$/g, '')
    const entryChecksums = response.data?.entryChecksums

    // 需要 anthropic/anthropic#283027。如果缺少 entryChecksums，
    // 视为探测失败 —— 调用方会使 push 失败，watcher 会重试。
    if (!entryChecksums || typeof entryChecksums !== 'object') {
      return {
        success: false,
        error: 'Server did not return entryChecksums (?view=hashes unsupported)',
        errorType: 'parse',
      }
    }

    if (checksum) {
      state.lastKnownChecksum = checksum
    }
    return {
      success: true,
      version: response.data?.version,
      checksum,
      entryChecksums,
    }
  } catch (error) {
    const { kind, status, message } = classifyAxiosError(error)
    switch (kind) {
      case 'auth':
        return {
          success: false,
          error: 'Not authorized',
          errorType: 'auth',
          httpStatus: status,
        }
      case 'timeout':
        return { success: false, error: 'Timeout', errorType: 'timeout' }
      case 'network':
        return { success: false, error: 'Network error', errorType: 'network' }
      default:
        return {
          success: false,
          error: message,
          errorType: 'unknown',
          httpStatus: status,
        }
    }
  }
}

async function fetchTeamMemory(
  state: SyncState,
  repoSlug: string,
  etag?: string | null,
): Promise<TeamMemorySyncFetchResult> {
  let lastResult: TeamMemorySyncFetchResult | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    lastResult = await fetchTeamMemoryOnce(state, repoSlug, etag)
    if (lastResult.success || lastResult.skipRetry) {
      return lastResult
    }
    if (attempt > MAX_RETRIES) {
      return lastResult
    }
    const delayMs = getRetryDelay(attempt)
    logForDebugging(`team-memory-sync: retry ${attempt}/${MAX_RETRIES}`, {
      level: 'debug',
    })
    await sleep(delayMs)
  }

  return lastResult!
}

// ─── 上传（push） ───────────────────────────────────────────

/**
 * 将增量拆分为每个不超过 MAX_PUT_BODY_BYTES 的 PUT 批次。
 *
 * 对排序后的 key 进行贪心装箱 —— 排序确保跨调用的批次确定性，
 * 这在冲突循环重试部分提交后对 ETag 稳定性很重要。
 * 字节数计算包含完整的序列化 body（包括 JSON 开销），
 * 因此我们测量的就是 axios 发送的大小。
 *
 * 单个条目超过 MAX_PUT_BODY_BYTES 时会独自成为一批
 * （MAX_FILE_SIZE_BYTES=250K 已经限制了单个文件大小；
 * ~250K 的独立 body 高于我们的软限制，但低于网关观察到的实际阈值）。
 */
export function batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>> {
  const keys = Object.keys(delta).sort()
  if (keys.length === 0) {
    return []
  }

  // `{"entries":{}}` 的固定开销 —— 每个条目然后增加其边际
  // 字节数。jsonStringify（底层等价于 JSON.stringify）处理原始
  // 字符串的转义，因此计数与 axios 序列化的结果匹配。
  const EMPTY_BODY_BYTES = Buffer.byteLength('{"entries":{}}', 'utf8')
  const entryBytes = (k: string, v: string): number =>
    Buffer.byteLength(jsonStringify(k), 'utf8') + Buffer.byteLength(jsonStringify(v), 'utf8') + 1 // 冒号 + 逗号（最后一个条目多算了 1 个逗号；无影响，只是余量）

  const batches: Array<Record<string, string>> = []
  let current: Record<string, string> = {}
  let currentBytes = EMPTY_BODY_BYTES

  for (const key of keys) {
    const added = entryBytes(key, delta[key]!)
    if (currentBytes + added > MAX_PUT_BODY_BYTES && Object.keys(current).length > 0) {
      batches.push(current)
      current = {}
      currentBytes = EMPTY_BODY_BYTES
    }
    current[key] = delta[key]!
    currentBytes += added
  }
  batches.push(current)
  return batches
}

async function uploadTeamMemory(
  state: SyncState,
  repoSlug: string,
  entries: Record<string, string>,
  ifMatchChecksum?: string | null,
): Promise<TeamMemorySyncUploadResult> {
  try {
    await checkAndRefreshOAuthTokenIfNeeded()

    const auth = getAuthHeaders()
    if (auth.error) {
      return { success: false, error: auth.error, errorType: 'auth' }
    }

    const headers: Record<string, string> = {
      ...auth.headers,
      'Content-Type': 'application/json',
    }
    if (ifMatchChecksum) {
      headers['If-Match'] = `"${ifMatchChecksum.replace(/"/g, '')}"`
    }

    const endpoint = getTeamMemorySyncEndpoint(repoSlug)
    const response = await axios.put(
      endpoint,
      { entries },
      {
        headers,
        timeout: TEAM_MEMORY_SYNC_TIMEOUT_MS,
        validateStatus: (status) => status === 200 || status === 412,
      },
    )

    if (response.status === 412) {
      logForDebugging('team-memory-sync: conflict (412 Precondition Failed)', {
        level: 'info',
      })
      return { success: false, conflict: true, error: 'ETag mismatch' }
    }

    const responseChecksum = response.data?.checksum
    if (responseChecksum) {
      state.lastKnownChecksum = responseChecksum
    }

    logForDebugging(
      `team-memory-sync: uploaded ${Object.keys(entries).length} entries (checksum: ${responseChecksum ?? 'none'})`,
      { level: 'debug' },
    )
    return {
      success: true,
      checksum: responseChecksum,
      lastModified: response.data?.lastModified,
    }
  } catch (error) {
    const body = axios.isAxiosError(error) ? JSON.stringify(error.response?.data ?? '') : ''
    logForDebugging(
      `team-memory-sync: upload failed: ${error instanceof Error ? error.message : ''} ${body}`,
      { level: 'warn' },
    )
    const { kind, status: httpStatus, message } = classifyAxiosError(error)
    const errorType = kind === 'http' || kind === 'other' ? 'unknown' : kind
    let serverErrorCode: 'team_memory_too_many_entries' | undefined
    let serverMaxEntries: number | undefined
    let serverReceivedEntries: number | undefined
    // 解析结构化 413（anthropic/anthropic#293258）。服务器的
    // RequestTooLargeException 包含 error_code + extra_details，其中
    // 有有效的 max_entries（可按组织进行 GB 级别调整）。缓存它以便
    // 下次 push 时截断到正确的值。
    if (httpStatus === 413 && axios.isAxiosError(error)) {
      const parsed = TeamMemoryTooManyEntriesSchema().safeParse(error.response?.data)
      if (parsed.success) {
        serverErrorCode = parsed.data.error.details.error_code
        serverMaxEntries = parsed.data.error.details.max_entries
        serverReceivedEntries = parsed.data.error.details.received_entries
      }
    }
    return {
      success: false,
      error: message,
      errorType,
      httpStatus,
      ...(serverErrorCode !== undefined && { serverErrorCode }),
      ...(serverMaxEntries !== undefined && { serverMaxEntries }),
      ...(serverReceivedEntries !== undefined && { serverReceivedEntries }),
    }
  }
}

// ─── 本地文件操作 ───────────────────────────────────────────

/**
 * 从本地目录读取所有团队记忆文件到一个扁平的 key-value 映射中。
 * Key 是相对于团队记忆目录的路径。
 * 空文件也会被包含（内容为空字符串）。
 *
 * PSR M22174：每个文件在包含之前都会使用 gitleaks 的模式扫描凭证。
 * 包含密钥的文件会被跳过（不上传），并收集到 skippedSecrets 中，
 * 以便调用方向用户发出警告。
 */
async function readLocalTeamMemory(maxEntries: number | null): Promise<{
  entries: Record<string, string>
  skippedSecrets: SkippedSecretFile[]
}> {
  const teamDir = getTeamMemPath()
  const entries: Record<string, string> = {}
  const skippedSecrets: SkippedSecretFile[] = []

  async function walkDir(dir: string): Promise<void> {
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true })
      await Promise.all(
        dirEntries.map(async (entry) => {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            await walkDir(fullPath)
          } else if (entry.isFile()) {
            try {
              const stats = await stat(fullPath)
              if (stats.size > MAX_FILE_SIZE_BYTES) {
                logForDebugging(
                  `team-memory-sync: skipping oversized file ${entry.name} (${stats.size} > ${MAX_FILE_SIZE_BYTES} bytes)`,
                  { level: 'info' },
                )
                return
              }
              const content = await readFile(fullPath, 'utf8')
              const relPath = relative(teamDir, fullPath).replaceAll('\\', '/')

              // PSR M22174：在添加到上传 payload 之前扫描密钥。
              // 如果检测到密钥，则完全跳过此文件，
              // 以确保它永远不会离开本机。
              const secretMatches = scanForSecrets(content)
              if (secretMatches.length > 0) {
                // 每个文件只报告第一个匹配项 —— 一个密钥就
                // 足以跳过文件，我们不想记录太多关于
                // 凭证位置的信息。
                const firstMatch = secretMatches[0]!
                skippedSecrets.push({
                  path: relPath,
                  ruleId: firstMatch.ruleId,
                  label: firstMatch.label,
                })
                logForDebugging(
                  `team-memory-sync: skipping "${relPath}" — detected ${firstMatch.label}`,
                  { level: 'warn' },
                )
                return
              }

              entries[relPath] = content
            } catch {
              // 跳过无法读取的文件
            }
          }
        }),
      )
    } catch (e) {
      if (isErrnoException(e)) {
        if (e.code !== 'ENOENT' && e.code !== 'EACCES' && e.code !== 'EPERM') {
          throw e
        }
      } else {
        throw e
      }
    }
  }

  await walkDir(teamDir)

  // 仅在从服务器学到上限后才截断（通过结构化
  // 413 的 extra_details.max_entries —— anthropic/anthropic#293258）。
  // 服务器的条目数量上限可通过 claude_code_team_memory_limits
  // 按组织进行 GB 级别调整；我们无法提前知道它。
  // 在第一次 413 之前我们发送所有内容，让服务器拥有
  // 最终决定权。服务器在合并后验证总存储条目数
  //（不是 PUT body 数量），并在 413 时原子性地拒绝 —— 不会写入任何内容。
  //
  // 截断前的排序是增量计算能够工作的前提：没有它，
  // 上面的并行遍历每次 push 会选择不同的 N/M 子集
  //（Promise.all 按完成顺序解析），serverChecksums 会遗漏 key，
  // 而"增量"会膨胀到接近完整快照。使用确定性
  // 截断，相同的 N 个 key 会与相同的服务器状态进行比较。
  //
  // 当磁盘文件数超过学习到的上限时，字母顺序最后的文件
  // 会一直无法同步。当合并后（服务器 + 增量）的数量超过
  // 上限时仍然会失败 —— 恢复需要 soft_delete_keys。
  const keys = Object.keys(entries).sort()
  if (maxEntries !== null && keys.length > maxEntries) {
    const dropped = keys.slice(maxEntries)
    logForDebugging(
      `team-memory-sync: ${keys.length} local entries exceeds server cap of ${maxEntries}; ${dropped.length} file(s) will NOT sync: ${dropped.join(', ')}. Consider consolidating or removing some team memory files.`,
      { level: 'warn' },
    )
    logEvent('zy_team_mem_entries_capped', {
      total_entries: keys.length,
      dropped_count: dropped.length,
      max_entries: maxEntries,
    })
    const truncated: Record<string, string> = {}
    for (const key of keys.slice(0, maxEntries)) {
      truncated[key] = entries[key]!
    }
    return { entries: truncated, skippedSecrets }
  }
  return { entries, skippedSecrets }
}

/**
 * 将远程团队记忆条目写入本地目录。
 * 验证每个路径是否超出团队记忆目录边界。
 * 跳过磁盘内容已匹配的条目，因此未更改的文件
 * 保留其 mtime，不会错误地使 getMemoryFile 缓存
 * 失效或触发 watcher 事件。
 *
 * 并行：每个条目独立处理（验证 + 读取比较
 * + mkdir + 写入）。共享父目录上的并发 mkdir 是安全的
 * recursive: true（EEXIST 会被吞掉）。初始 pull 是
 * startTeamMemoryWatcher 中的耗时操作 —— 50 个条目时 p99 串行约 ~22s。
 *
 * 返回实际写入的文件数量。
 */
async function writeRemoteEntriesToLocal(entries: Record<string, string>): Promise<number> {
  const results = await Promise.all(
    Object.entries(entries).map(async ([relPath, content]) => {
      let validatedPath: string
      try {
        validatedPath = await validateTeamMemKey(relPath)
      } catch (e) {
        if (e instanceof PathTraversalError) {
          logForDebugging(`team-memory-sync: ${e.message}`, { level: 'warn' })
          return false
        }
        throw e
      }

      const sizeBytes = Buffer.byteLength(content, 'utf8')
      if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        logForDebugging(`team-memory-sync: skipping oversized remote entry "${relPath}"`, {
          level: 'info',
        })
        return false
      }

      // 如果磁盘内容已经匹配则跳过。处理常见情况：
      // pull 返回未更改的条目（skipEtagCache 路径，前一会话
      // 有热磁盘状态的首次拉取）。
      try {
        const existing = await readFile(validatedPath, 'utf8')
        if (existing === content) {
          return false
        }
      } catch (e) {
        if (isErrnoException(e) && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
          logForDebugging(`team-memory-sync: unexpected read error for "${relPath}": ${e.code}`, {
            level: 'debug',
          })
        }
        // 对 ENOENT/ENOTDIR（文件尚不存在）继续执行写入
      }

      try {
        const parentDir = validatedPath.substring(0, validatedPath.lastIndexOf(sep))
        await mkdir(parentDir, { recursive: true })
        await writeFile(validatedPath, content, 'utf8')
        return true
      } catch (e) {
        logForDebugging(`team-memory-sync: failed to write "${relPath}": ${e}`, { level: 'warn' })
        return false
      }
    }),
  )

  return count(results, Boolean)
}

// ─── 公共 API ──────────────────────────────────────────────

/**
 * 检查团队记忆同步是否可用（需要 ZY OAuth）。
 */
export function isTeamMemorySyncAvailable(): boolean {
  return isUsingOAuth()
}

/**
 * 从服务器拉取团队记忆并写入本地目录。
 * 如果有任何文件被更新则返回 true。
 */
export async function pullTeamMemory(
  state: SyncState,
  options?: { skipEtagCache?: boolean },
): Promise<{
  success: boolean
  filesWritten: number
  /** 服务器返回的条目数量，无论是否写入磁盘。 */
  entryCount: number
  notModified?: boolean
  error?: string
}> {
  const skipEtagCache = options?.skipEtagCache ?? false
  const startTime = Date.now()

  if (!isUsingOAuth()) {
    logPull(startTime, { success: false, errorType: 'no_oauth' })
    return {
      success: false,
      filesWritten: 0,
      entryCount: 0,
      error: 'OAuth not available',
    }
  }

  const repoSlug = await getGithubRepo()
  if (!repoSlug) {
    logPull(startTime, { success: false, errorType: 'no_repo' })
    return {
      success: false,
      filesWritten: 0,
      entryCount: 0,
      error: 'No git remote found',
    }
  }

  const etag = skipEtagCache ? null : state.lastKnownChecksum
  const result = await fetchTeamMemory(state, repoSlug, etag)
  if (!result.success) {
    logPull(startTime, {
      success: false,
      errorType: result.errorType,
      status: result.httpStatus,
    })
    return {
      success: false,
      filesWritten: 0,
      entryCount: 0,
      error: result.error,
    }
  }
  if (result.notModified) {
    logPull(startTime, { success: true, notModified: true })
    return { success: true, filesWritten: 0, entryCount: 0, notModified: true }
  }
  if (result.isEmpty || !result.data) {
    // 服务器没有数据 —— 清除过时的 serverChecksums，
    // 这样下次 push 不会跳过它认为服务器已有的条目。
    state.serverChecksums.clear()
    logPull(startTime, { success: true })
    return { success: true, filesWritten: 0, entryCount: 0 }
  }

  const entries = result.data.content.entries
  const responseChecksums = result.data.content.entryChecksums

  // 从服务器提供的每个 key 的哈希刷新 serverChecksums。
  // 需要 anthropic/anthropic#283027 —— 如果响应缺少 entryChecksums
  //（部署前的服务器），serverChecksums 保持为空，下次 push 会全量上传；
  // 它在 push 成功后会自我修正。
  state.serverChecksums.clear()
  if (responseChecksums) {
    for (const [key, hash] of Object.entries(responseChecksums)) {
      state.serverChecksums.set(key, hash)
    }
  } else {
    logForDebugging(
      'team-memory-sync: server response missing entryChecksums (pre-#283027 deploy) — next push will be full, not delta',
      { level: 'debug' },
    )
  }

  const filesWritten = await writeRemoteEntriesToLocal(entries)
  if (filesWritten > 0) {
    const { clearMemoryFileCaches } = await import('../../utils/zymd.js')
    clearMemoryFileCaches()
  }
  logForDebugging(`team-memory-sync: pulled ${filesWritten} files`, {
    level: 'info',
  })

  logPull(startTime, { success: true, filesWritten })

  return {
    success: true,
    filesWritten,
    entryCount: Object.keys(entries).length,
  }
}

/**
 * 使用乐观锁将本地团队记忆文件推送到服务器。
 *
 * 使用增量上传：仅包含本地内容哈希与
 * serverChecksums 不同的 key 到 PUT 中。遇到 412 冲突时，探测
 * GET ?view=hashes 来刷新 serverChecksums，重新计算增量
 *（自然排除了队友 push 中与我们内容相同的 key），
 * 并重试。不合并、不写入磁盘 —— 队友并发 push
 * 带来的服务器新 key 会在下次 pull 时传播。
 *
 * 冲突时本地优先与 syncTeamMemory 的 pull 优先
 * 语义相反。这是有意为之：pushTeamMemory 由本地编辑触发，
 * 该编辑不能因为队友同时 push 而被静默丢弃。
 * 内容级别合并（同一个 key，双方都改了）不会
 * 尝试 —— 本地版本直接覆盖服务器版本，
 * 而服务器对该 key 的编辑会丢失。这是两害相权取其轻：
 * 本地用户正在积极编辑，可以重新整合队友的
 * 更改，而静默丢弃本地编辑会使用户刚刚完成的工作
 * 无法挽回地丢失。
 */
export async function pushTeamMemory(state: SyncState): Promise<TeamMemorySyncPushResult> {
  const startTime = Date.now()
  let conflictRetries = 0

  if (!isUsingOAuth()) {
    logPush(startTime, { success: false, errorType: 'no_oauth' })
    return {
      success: false,
      filesUploaded: 0,
      error: 'OAuth not available',
      errorType: 'no_oauth',
    }
  }

  const repoSlug = await getGithubRepo()
  if (!repoSlug) {
    logPush(startTime, { success: false, errorType: 'no_repo' })
    return {
      success: false,
      filesUploaded: 0,
      error: 'No git remote found',
      errorType: 'no_repo',
    }
  }

  // 在开始时读取本地条目一次。冲突解决不会重新从
  // 磁盘读取 —— 针对刷新后的 serverChecksums 计算增量自然
  // 排除了来自服务器的内容，因此用户的本地编辑不会被覆盖。
  // 密钥扫描（PSR M22174）在这里只执行一次 —— 包含密钥的文件
  // 会被排除在上传集合之外。
  const localRead = await readLocalTeamMemory(state.serverMaxEntries)
  const entries = localRead.entries
  const skippedSecrets = localRead.skippedSecrets
  if (skippedSecrets.length > 0) {
    // 记录用户可见的警告，列出哪些文件被跳过及原因。
    // 不阻塞 push —— 仅排除这些文件。密钥的 VALUE
    // 永远不会被记录，只记录类型标签。
    const summary = skippedSecrets.map((s) => `"${s.path}" (${s.label})`).join(', ')
    logForDebugging(
      `team-memory-sync: ${skippedSecrets.length} file(s) skipped due to detected secrets: ${summary}. Remove the secret(s) to enable sync for these files.`,
      { level: 'warn' },
    )
    logEvent('zy_team_mem_secret_skipped', {
      file_count: skippedSecrets.length,
      // 只记录 gitleaks 规则 ID（不记录值，不记录路径 —— 路径可能
      // 泄漏仓库结构）。逗号连接以压缩为单个 analytics 字段。
      rule_ids: skippedSecrets
        .map((s) => s.ruleId)
        .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 对每个本地条目哈希一次。循环在每次迭代时重新计算增量
  //（serverChecksums 可能在 412 探测后变化），但本地哈希是稳定的。
  const localHashes = new Map<string, string>()
  for (const [key, content] of Object.entries(entries)) {
    localHashes.set(key, hashContent(content))
  }

  let sawConflict = false

  for (let conflictAttempt = 0; conflictAttempt <= MAX_CONFLICT_RETRIES; conflictAttempt++) {
    // 增量：仅上传内容哈希与我们认为服务器持有的
    // 内容不同的 key。首次 pull 后的 push，这正好是
    // 用户的本地编辑。412 探测后，匹配的哈希被排除 ——
    // 队友并发 push 带来的服务器内容自然被
    // 从增量中排除，因此我们永远不会重新上传它。
    const delta: Record<string, string> = {}
    for (const [key, localHash] of localHashes) {
      if (state.serverChecksums.get(key) !== localHash) {
        delta[key] = entries[key]!
      }
    }
    const deltaCount = Object.keys(delta).length

    if (deltaCount === 0) {
      // 没有可上传的内容。这是拉取后没有本地编辑时的预期快速路径，
      // 也是 412 后队友 push 是我们严格超集时的收敛点。
      logPush(startTime, {
        success: true,
        conflict: sawConflict,
        conflictRetries,
      })
      return {
        success: true,
        filesUploaded: 0,
        ...(skippedSecrets.length > 0 && { skippedSecrets }),
      }
    }

    // 将增量拆分为 PUT 大小的批次，以保持在网关的
    // body 大小限制之下。典型的增量（1-3 个已编辑文件）会落在一个批次中；
    // 包含多个文件的冷推送才是它发挥作用的地方。每个批次
    // 是一个完整的 PUT，独立 upsert 其 key —— 如果批次 N
    // 失败，批次 1..N-1 已经在服务器端提交。每次成功后更新
    // serverChecksums 意味着外部冲突循环的重试
    // 自然会从未提交的尾部恢复（这些 key 仍然不同）。
    // state.lastKnownChecksum 在 uploadTeamMemory 中每次
    // 200 响应时更新，因此 ETag 链自动贯穿批次。
    const batches = batchDeltaByBytes(delta)
    let filesUploaded = 0
    let result: TeamMemorySyncUploadResult | undefined

    for (const batch of batches) {
      result = await uploadTeamMemory(state, repoSlug, batch, state.lastKnownChecksum)
      if (!result.success) {
        break
      }

      for (const key of Object.keys(batch)) {
        state.serverChecksums.set(key, localHashes.get(key)!)
      }
      filesUploaded += Object.keys(batch).length
    }
    // 批次非空（deltaCount > 0 由上面的检查保证），
    // 因此循环至少执行了一次。
    result = result!

    if (result.success) {
      // 服务器端增量传播到磁盘（队友并发 push 带来的
      // 服务器新 key）会在下次 pull 时发生 —— 我们在
      // 冲突解决期间只获取了哈希，没有获取内容。
      logForDebugging(
        batches.length > 1
          ? `team-memory-sync: pushed ${filesUploaded} of ${localHashes.size} files in ${batches.length} batches`
          : `team-memory-sync: pushed ${filesUploaded} of ${localHashes.size} files (delta)`,
        { level: 'info' },
      )
      logPush(startTime, {
        success: true,
        filesUploaded,
        conflict: sawConflict,
        conflictRetries,
        putBatches: batches.length > 1 ? batches.length : undefined,
      })
      return {
        success: true,
        filesUploaded,
        checksum: result.checksum,
        ...(skippedSecrets.length > 0 && { skippedSecrets }),
      }
    }

    if (!result.conflict) {
      // 如果服务器返回了结构化的 413 及其有效的
      // max_entries（anthropic/anthropic#293258），缓存它以便下次 push
      // 截断到正确的上限。服务器可能按组织进行 GB 级别调整。
      // 这次 push 仍然失败 —— 在 push 中间重新截断需要重新读取
      // 本地条目并重新计算增量，而且我们需要
      // soft_delete_keys 来缩小到当前服务器计数以下。
      if (result.serverMaxEntries !== undefined) {
        state.serverMaxEntries = result.serverMaxEntries
        logForDebugging(
          `team-memory-sync: learned server max_entries=${result.serverMaxEntries} from 413; next push will truncate to this`,
          { level: 'warn' },
        )
      }
      // filesUploaded 可能非零，如果之前的批次在
      // 此批次失败前已提交。这些 key 确实已经在服务器上；
      // push 是不完整的所以视为失败，但重试时不会重新上传它们
      //（serverChecksums 已被更新）。
      logPush(startTime, {
        success: false,
        filesUploaded,
        conflictRetries,
        putBatches: batches.length > 1 ? batches.length : undefined,
        errorType: result.errorType,
        status: result.httpStatus,
        // Datadog：筛选 @error_code:team_memory_too_many_entries 以跟踪
        // 文件过多被拒绝的情况，区别于网关/非结构化 413
        errorCode: result.serverErrorCode,
        serverMaxEntries: result.serverMaxEntries,
        serverReceivedEntries: result.serverReceivedEntries,
      })
      return {
        success: false,
        filesUploaded,
        error: result.error,
        errorType: result.errorType,
        httpStatus: result.httpStatus,
      }
    }

    // 412 冲突 —— 刷新 serverChecksums 并用更紧凑的增量重试。
    sawConflict = true
    if (conflictAttempt >= MAX_CONFLICT_RETRIES) {
      logForDebugging(
        `team-memory-sync: giving up after ${MAX_CONFLICT_RETRIES} conflict retries`,
        { level: 'warn' },
      )
      logPush(startTime, {
        success: false,
        conflict: true,
        conflictRetries,
        errorType: 'conflict',
      })
      return {
        success: false,
        filesUploaded: 0,
        conflict: true,
        error: 'Conflict resolution failed after retries',
      }
    }

    conflictRetries++

    logForDebugging(
      `team-memory-sync: conflict (412), probing server hashes (attempt ${conflictAttempt + 1}/${MAX_CONFLICT_RETRIES})`,
      { level: 'info' },
    )

    // 廉价探测：仅获取每个 key 的校验和，不含条目内容。刷新
    // serverChecksums 以便下次迭代的增量排除队友刚 push 的
    // 内容相同的 key。
    const probe = await fetchTeamMemoryHashes(state, repoSlug)
    if (!probe.success || !probe.entryChecksums) {
      // 需要 anthropic/anthropic#283027。此处短暂的探测失败
      // 没问题：push 会失败，watcher 会在下次编辑时重试。
      logPush(startTime, {
        success: false,
        conflict: true,
        conflictRetries,
        errorType: 'conflict',
      })
      return {
        success: false,
        filesUploaded: 0,
        conflict: true,
        error: `Conflict resolution hashes probe failed: ${probe.error}`,
      }
    }
    state.serverChecksums.clear()
    for (const [key, hash] of Object.entries(probe.entryChecksums)) {
      state.serverChecksums.set(key, hash)
    }
  }

  logPush(startTime, { success: false, conflictRetries })
  return {
    success: false,
    filesUploaded: 0,
    error: 'Unexpected end of conflict resolution loop',
  }
}

/**
 * 双向同步：从服务器拉取，与本地合并，再推送回去。
 * 冲突时服务器条目优先（服务器最后写入者获胜）。
 * Push 使用冲突解决（412 时重试），通过 pushTeamMemory 实现。
 */
export async function syncTeamMemory(state: SyncState): Promise<{
  success: boolean
  filesPulled: number
  filesPushed: number
  error?: string
}> {
  // 1. 从远程拉取到本地（跳过 ETag 缓存以进行完整同步）
  const pullResult = await pullTeamMemory(state, { skipEtagCache: true })
  if (!pullResult.success) {
    return {
      success: false,
      filesPulled: 0,
      filesPushed: 0,
      error: pullResult.error,
    }
  }

  // 2. 从本地推送到远程（带冲突解决）
  const pushResult = await pushTeamMemory(state)
  if (!pushResult.success) {
    return {
      success: false,
      filesPulled: pullResult.filesWritten,
      filesPushed: 0,
      error: pushResult.error,
    }
  }

  logForDebugging(
    `team-memory-sync: synced (pulled ${pullResult.filesWritten}, pushed ${pushResult.filesUploaded})`,
    { level: 'info' },
  )

  return {
    success: true,
    filesPulled: pullResult.filesWritten,
    filesPushed: pushResult.filesUploaded,
  }
}

// ─── 遥测辅助函数 ───────────────────────────────────────

function logPull(
  startTime: number,
  outcome: {
    success: boolean
    filesWritten?: number
    notModified?: boolean
    errorType?: string
    status?: number
  },
): void {
  logEvent('zy_team_mem_sync_pull', {
    success: outcome.success,
    files_written: outcome.filesWritten ?? 0,
    not_modified: outcome.notModified ?? false,
    duration_ms: Date.now() - startTime,
    ...(outcome.errorType && {
      errorType: outcome.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.status && { status: outcome.status }),
  })
}

function logPush(
  startTime: number,
  outcome: {
    success: boolean
    filesUploaded?: number
    conflict?: boolean
    conflictRetries?: number
    errorType?: string
    status?: number
    putBatches?: number
    errorCode?: string
    serverMaxEntries?: number
    serverReceivedEntries?: number
  },
): void {
  logEvent('zy_team_mem_sync_push', {
    success: outcome.success,
    files_uploaded: outcome.filesUploaded ?? 0,
    conflict: outcome.conflict ?? false,
    conflict_retries: outcome.conflictRetries ?? 0,
    duration_ms: Date.now() - startTime,
    ...(outcome.errorType && {
      errorType: outcome.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.status && { status: outcome.status }),
    ...(outcome.putBatches && { put_batches: outcome.putBatches }),
    ...(outcome.errorCode && {
      error_code: outcome.errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.serverMaxEntries !== undefined && {
      server_max_entries: outcome.serverMaxEntries,
    }),
    ...(outcome.serverReceivedEntries !== undefined && {
      server_received_entries: outcome.serverReceivedEntries,
    }),
  })
}
