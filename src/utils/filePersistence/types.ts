// Stub for src/utils/filePersistence/types.ts

export const DEFAULT_UPLOAD_CONCURRENCY = 4
export const FILE_COUNT_LIMIT = 100
export const OUTPUTS_SUBDIR = 'outputs'

export type TurnStartTime = {
  wallMs: number
  processMs: number
}

export type PersistedFile = {
  path: string
  content: string
  encoding: string
}

export type FailedPersistence = {
  path: string
  error: string
}

export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
}
