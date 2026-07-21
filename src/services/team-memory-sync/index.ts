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
 *   - 本地文件删除不会传播到服务器；下次 pull 会重新恢复到本地。
 */

import { logForDebugging } from '../../services/infra/debug.js'
import { getGithubRepo } from '../../services/infra/git.js'
import { logEvent } from '../analytics/index.js'
import { type SkippedSecretFile, type TeamMemorySyncPushResult } from './types.js'
import {
  batchDeltaByBytes,
  fetchTeamMemory,
  fetchTeamMemoryHashes,
  uploadTeamMemory,
} from './teamMemorySyncRemote.js'
import {
  buildSkippedSecretsAnalyticsValue,
  readLocalTeamMemory,
  writeRemoteEntriesToLocal,
} from './teamMemorySyncLocal.js'
import { logPull, logPush } from './teamMemorySyncTelemetry.js'
import {
  createSyncState,
  hashContent,
  isUsingOAuth,
  MAX_CONFLICT_RETRIES,
  type SyncState,
} from './teamMemorySyncShared.js'

export { batchDeltaByBytes } from './teamMemorySyncRemote.js'
export { createSyncState, hashContent, type SyncState } from './teamMemorySyncShared.js'

export function isTeamMemorySyncAvailable(): boolean {
  return isUsingOAuth()
}

export async function pullTeamMemory(
  state: SyncState,
  options?: { skipEtagCache?: boolean },
): Promise<{
  success: boolean
  filesWritten: number
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
    state.serverChecksums.clear()
    logPull(startTime, { success: true })
    return { success: true, filesWritten: 0, entryCount: 0 }
  }

  const entries = result.data.content.entries
  const responseChecksums = result.data.content.entryChecksums

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
    const { clearMemoryFileCaches } = await import('../../services/memory/agentsMd.js')
    clearMemoryFileCaches()
  }

  logForDebugging(`team-memory-sync: pulled ${filesWritten} files`, { level: 'info' })
  logPull(startTime, { success: true, filesWritten })

  return {
    success: true,
    filesWritten,
    entryCount: Object.keys(entries).length,
  }
}

function logSkippedSecrets(skippedSecrets: SkippedSecretFile[]): void {
  if (skippedSecrets.length === 0) {
    return
  }

  const summary = skippedSecrets.map((item) => `"${item.path}" (${item.label})`).join(', ')
  logForDebugging(
    `team-memory-sync: ${skippedSecrets.length} file(s) skipped due to detected secrets: ${summary}. Remove the secret(s) to enable sync for these files.`,
    { level: 'warn' },
  )
  logEvent('zy_team_mem_secret_skipped', {
    file_count: skippedSecrets.length,
    rule_ids: buildSkippedSecretsAnalyticsValue(skippedSecrets),
  })
}

function buildLocalHashes(entries: Record<string, string>): Map<string, string> {
  const localHashes = new Map<string, string>()
  for (const [key, content] of Object.entries(entries)) {
    localHashes.set(key, hashContent(content))
  }
  return localHashes
}

function buildDelta(
  entries: Record<string, string>,
  localHashes: Map<string, string>,
  serverChecksums: Map<string, string>,
): Record<string, string> {
  const delta: Record<string, string> = {}
  for (const [key, localHash] of localHashes) {
    if (serverChecksums.get(key) !== localHash) {
      delta[key] = entries[key]!
    }
  }
  return delta
}

async function uploadDeltaBatches(
  state: SyncState,
  repoSlug: string,
  delta: Record<string, string>,
  localHashes: Map<string, string>,
): Promise<{
  filesUploaded: number
  batches: Array<Record<string, string>>
  result: Awaited<ReturnType<typeof uploadTeamMemory>>
}> {
  const batches = batchDeltaByBytes(delta)
  let filesUploaded = 0
  let result: Awaited<ReturnType<typeof uploadTeamMemory>> | undefined

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

  return {
    filesUploaded,
    batches,
    result: result!,
  }
}

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

  const localRead = await readLocalTeamMemory(state.serverMaxEntries)
  const entries = localRead.entries
  const skippedSecrets = localRead.skippedSecrets
  logSkippedSecrets(skippedSecrets)

  const localHashes = buildLocalHashes(entries)
  let sawConflict = false

  for (let conflictAttempt = 0; conflictAttempt <= MAX_CONFLICT_RETRIES; conflictAttempt++) {
    const delta = buildDelta(entries, localHashes, state.serverChecksums)
    const deltaCount = Object.keys(delta).length

    if (deltaCount === 0) {
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

    const { filesUploaded, batches, result } = await uploadDeltaBatches(
      state,
      repoSlug,
      delta,
      localHashes,
    )

    if (result.success) {
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
      if (result.serverMaxEntries !== undefined) {
        state.serverMaxEntries = result.serverMaxEntries
        logForDebugging(
          `team-memory-sync: learned server max_entries=${result.serverMaxEntries} from 413; next push will truncate to this`,
          { level: 'warn' },
        )
      }
      logPush(startTime, {
        success: false,
        filesUploaded,
        conflictRetries,
        putBatches: batches.length > 1 ? batches.length : undefined,
        errorType: result.errorType,
        status: result.httpStatus,
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

    const probe = await fetchTeamMemoryHashes(state, repoSlug)
    if (!probe.success || !probe.entryChecksums) {
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

export async function syncTeamMemory(state: SyncState): Promise<{
  success: boolean
  filesPulled: number
  filesPushed: number
  error?: string
}> {
  const pullResult = await pullTeamMemory(state, { skipEtagCache: true })
  if (!pullResult.success) {
    return {
      success: false,
      filesPulled: 0,
      filesPushed: 0,
      error: pullResult.error,
    }
  }

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
