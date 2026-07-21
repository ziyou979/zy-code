import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { logForDebugging } from '../../services/infra/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import * as lockfile from '../file-persistence/lockfile.js'
import { logError } from '../../services/infra/log.js'
import { jsonParse, jsonStringify } from '../../services/infra/slowOperations.js'
import { getTeamDir } from './teamHelpers.js'
import type { PermissionUpdate } from '../permissions/permissionUpdateSchema.js'

export const SwarmPermissionRequestSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    workerColor: z.string().optional(),
    teamName: z.string(),
    toolName: z.string(),
    toolUseId: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()),
    permissionSuggestions: z.array(z.unknown()),
    status: z.enum(['pending', 'approved', 'rejected']),
    resolvedBy: z.enum(['worker', 'leader']).optional(),
    resolvedAt: z.number().optional(),
    feedback: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    permissionUpdates: z.array(z.unknown()).optional(),
    createdAt: z.number(),
  }),
)

export type SwarmPermissionRequest = z.infer<ReturnType<typeof SwarmPermissionRequestSchema>>

type PermissionResolutionRecord = {
  decision: 'approved' | 'rejected'
  resolvedBy: 'worker' | 'leader'
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
}

export function getPermissionDir(teamName: string): string {
  return join(getTeamDir(teamName), 'permissions')
}

function getPendingDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'pending')
}

function getResolvedDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'resolved')
}

async function ensurePermissionDirsAsync(teamName: string): Promise<void> {
  const permDir = getPermissionDir(teamName)
  const pendingDir = getPendingDir(teamName)
  const resolvedDir = getResolvedDir(teamName)

  for (const dir of [permDir, pendingDir, resolvedDir]) {
    await mkdir(dir, { recursive: true })
  }
}

function getPendingRequestPath(teamName: string, requestId: string): string {
  return join(getPendingDir(teamName), `${requestId}.json`)
}

function getResolvedRequestPath(teamName: string, requestId: string): string {
  return join(getResolvedDir(teamName), `${requestId}.json`)
}

async function withPendingDirectoryLock<T>(teamName: string, action: () => Promise<T>): Promise<T> {
  const lockFilePath = join(getPendingDir(teamName), '.lock')
  await writeFile(lockFilePath, '', 'utf-8')

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(lockFilePath)
    return await action()
  } finally {
    if (release) {
      await release()
    }
  }
}

async function readRequestFile(
  filePath: string,
  invalidLogPrefix: string,
  failureLogPrefix: string,
): Promise<SwarmPermissionRequest | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
    if (parsed.success) {
      return parsed.data
    }

    logForDebugging(`[PermissionSync] ${invalidLogPrefix}: ${parsed.error.message}`)
    return null
  } catch (error) {
    logForDebugging(`[PermissionSync] ${failureLogPrefix}: ${error}`)
    return null
  }
}

export async function writePermissionRequestFile(
  request: SwarmPermissionRequest,
): Promise<SwarmPermissionRequest> {
  await ensurePermissionDirsAsync(request.teamName)

  const pendingPath = getPendingRequestPath(request.teamName, request.id)

  try {
    return await withPendingDirectoryLock(request.teamName, async () => {
      await writeFile(pendingPath, jsonStringify(request, null, 2), 'utf-8')

      logForDebugging(
        `[PermissionSync] Wrote pending request ${request.id} from ${request.workerName} for ${request.toolName}`,
      )

      return request
    })
  } catch (error) {
    logForDebugging(`[PermissionSync] Failed to write permission request: ${error}`)
    logError(error)
    throw error
  }
}

export async function readPendingPermissionsForTeam(
  teamName: string,
): Promise<SwarmPermissionRequest[]> {
  const pendingDir = getPendingDir(teamName)

  let files: string[]
  try {
    files = await readdir(pendingDir)
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return []
    }
    logForDebugging(`[PermissionSync] Failed to read pending requests: ${error}`)
    logError(error)
    return []
  }

  const results = await Promise.all(
    files
      .filter((file) => file.endsWith('.json') && file !== '.lock')
      .map((file) =>
        readRequestFile(
          join(pendingDir, file),
          `Invalid request file ${file}`,
          `Failed to read request file ${file}`,
        ),
      ),
  )

  const requests = results.filter((request) => request !== null)
  requests.sort((left, right) => left.createdAt - right.createdAt)
  return requests
}

export async function readResolvedPermissionForTeam(
  requestId: string,
  teamName: string,
): Promise<SwarmPermissionRequest | null> {
  const resolvedPath = getResolvedRequestPath(teamName, requestId)

  try {
    const content = await readFile(resolvedPath, 'utf-8')
    const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
    if (parsed.success) {
      return parsed.data
    }
    logForDebugging(
      `[PermissionSync] Invalid resolved request ${requestId}: ${parsed.error.message}`,
    )
    return null
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return null
    }
    logForDebugging(`[PermissionSync] Failed to read resolved request ${requestId}: ${error}`)
    logError(error)
    return null
  }
}

export async function resolvePermissionForTeam(
  requestId: string,
  resolution: PermissionResolutionRecord,
  teamName: string,
): Promise<boolean> {
  await ensurePermissionDirsAsync(teamName)

  const pendingPath = getPendingRequestPath(teamName, requestId)
  const resolvedPath = getResolvedRequestPath(teamName, requestId)

  try {
    return await withPendingDirectoryLock(teamName, async () => {
      let content: string
      try {
        content = await readFile(pendingPath, 'utf-8')
      } catch (error: unknown) {
        const code = getErrnoCode(error)
        if (code === 'ENOENT') {
          logForDebugging(`[PermissionSync] Pending request not found: ${requestId}`)
          return false
        }
        throw error
      }

      const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
      if (!parsed.success) {
        logForDebugging(
          `[PermissionSync] Invalid pending request ${requestId}: ${parsed.error.message}`,
        )
        return false
      }

      const resolvedRequest: SwarmPermissionRequest = {
        ...parsed.data,
        status: resolution.decision === 'approved' ? 'approved' : 'rejected',
        resolvedBy: resolution.resolvedBy,
        resolvedAt: Date.now(),
        feedback: resolution.feedback,
        updatedInput: resolution.updatedInput,
        permissionUpdates: resolution.permissionUpdates,
      }

      await writeFile(resolvedPath, jsonStringify(resolvedRequest, null, 2), 'utf-8')
      await unlink(pendingPath)

      logForDebugging(`[PermissionSync] Resolved request ${requestId} with ${resolution.decision}`)
      return true
    })
  } catch (error) {
    logForDebugging(`[PermissionSync] Failed to resolve request: ${error}`)
    logError(error)
    return false
  }
}

export async function deleteResolvedPermissionForTeam(
  requestId: string,
  teamName: string,
): Promise<boolean> {
  try {
    await unlink(getResolvedRequestPath(teamName, requestId))
    logForDebugging(`[PermissionSync] Deleted resolved permission: ${requestId}`)
    return true
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return false
    }
    logForDebugging(`[PermissionSync] Failed to delete resolved permission: ${error}`)
    logError(error)
    return false
  }
}

export async function cleanupOldResolutionsForTeam(
  teamName: string,
  maxAgeMs: number,
): Promise<number> {
  const resolvedDir = getResolvedDir(teamName)

  let files: string[]
  try {
    files = await readdir(resolvedDir)
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return 0
    }
    logForDebugging(`[PermissionSync] Failed to cleanup resolutions: ${error}`)
    logError(error)
    return 0
  }

  const now = Date.now()
  const cleanupResults = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        const filePath = join(resolvedDir, file)
        try {
          const content = await readFile(filePath, 'utf-8')
          const request = jsonParse(content) as SwarmPermissionRequest
          const resolvedAt = request.resolvedAt || request.createdAt
          if (now - resolvedAt >= maxAgeMs) {
            await unlink(filePath)
            logForDebugging(`[PermissionSync] Cleaned up old resolution: ${file}`)
            return 1
          }
          return 0
        } catch {
          try {
            await unlink(filePath)
            return 1
          } catch {
            return 0
          }
        }
      }),
  )

  const cleanedCount = cleanupResults.reduce<number>((sum, count) => sum + count, 0)
  if (cleanedCount > 0) {
    logForDebugging(`[PermissionSync] Cleaned up ${cleanedCount} old resolutions`)
  }
  return cleanedCount
}
