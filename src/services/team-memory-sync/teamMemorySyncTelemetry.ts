/**
 * 团队记忆同步遥测辅助函数。
 */

import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import { logEvent } from '../analytics/index.js'

export function logPull(
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

export function logPush(
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
