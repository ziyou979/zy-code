/**
 * 团队记忆同步远端 API 能力。
 */

import axios from 'axios'
import { logForDebugging } from '../../utils/debug.js'
import { classifyAxiosError } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getRetryDelay } from '../api/withRetry.js'
import {
  type TeamMemoryHashesResult,
  TeamMemoryDataSchema,
  type TeamMemorySyncFetchResult,
  type TeamMemorySyncUploadResult,
  TeamMemoryTooManyEntriesSchema,
} from './types.js'
import {
  ensureTeamMemoryAuthReady,
  getAuthHeaders,
  getTeamMemorySyncEndpoint,
  MAX_PUT_BODY_BYTES,
  MAX_RETRIES,
  TEAM_MEMORY_SYNC_TIMEOUT_MS,
  type SyncState,
} from './teamMemorySyncShared.js'

async function fetchTeamMemoryOnce(
  state: SyncState,
  repoSlug: string,
  etag?: string | null,
): Promise<TeamMemorySyncFetchResult> {
  try {
    await ensureTeamMemoryAuthReady()

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
      logForDebugging('team-memory-sync: not modified (304)', { level: 'debug' })
      return { success: true, notModified: true, checksum: etag ?? undefined }
    }

    if (response.status === 404) {
      logForDebugging('team-memory-sync: no remote data (404)', { level: 'debug' })
      state.lastKnownChecksum = null
      return { success: true, isEmpty: true }
    }

    const parsed = TeamMemoryDataSchema().safeParse(response.data)
    if (!parsed.success) {
      logForDebugging('team-memory-sync: invalid response format', { level: 'warn' })
      return {
        success: false,
        error: 'Invalid team memory response format',
        skipRetry: true,
        errorType: 'parse',
      }
    }

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
      logForDebugging(`team-memory-sync: fetch error ${status}: ${body}`, { level: 'warn' })
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

export async function fetchTeamMemoryHashes(
  state: SyncState,
  repoSlug: string,
): Promise<TeamMemoryHashesResult> {
  try {
    await ensureTeamMemoryAuthReady()
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

export async function fetchTeamMemory(
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
    logForDebugging(`team-memory-sync: retry ${attempt}/${MAX_RETRIES}`, { level: 'debug' })
    await sleep(delayMs)
  }

  return lastResult!
}

export function batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>> {
  const keys = Object.keys(delta).sort()
  if (keys.length === 0) {
    return []
  }

  const emptyBodyBytes = Buffer.byteLength('{"entries":{}}', 'utf8')
  const entryBytes = (k: string, v: string): number =>
    Buffer.byteLength(jsonStringify(k), 'utf8') + Buffer.byteLength(jsonStringify(v), 'utf8') + 1

  const batches: Array<Record<string, string>> = []
  let current: Record<string, string> = {}
  let currentBytes = emptyBodyBytes

  for (const key of keys) {
    const added = entryBytes(key, delta[key]!)
    if (currentBytes + added > MAX_PUT_BODY_BYTES && Object.keys(current).length > 0) {
      batches.push(current)
      current = {}
      currentBytes = emptyBodyBytes
    }
    current[key] = delta[key]!
    currentBytes += added
  }
  batches.push(current)
  return batches
}

export async function uploadTeamMemory(
  state: SyncState,
  repoSlug: string,
  entries: Record<string, string>,
  ifMatchChecksum?: string | null,
): Promise<TeamMemorySyncUploadResult> {
  try {
    await ensureTeamMemoryAuthReady()

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
