/**
 * Outputs directory scanner for file persistence
 *
 * This module provides utilities to:
 * - Detect the session type from environment variables
 * - Capture turn start timestamp
 * - Find modified files by comparing file mtimes against turn start time
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EnvironmentKind } from 'src/services/teleport/environments.js'
import { logForDebugging } from '../../utils/debug.js'
import type { TurnStartTime } from './types.js'

/** Shared debug logger for file persistence modules */
export function logDebug(message: string): void {
  logForDebugging(`[file-persistence] ${message}`)
}

/**
 * Get the environment kind from ZY_CODE_ENVIRONMENT_KIND.
 * Returns null if not set or not a recognized value.
 */
export function getEnvironmentKind(): EnvironmentKind | null {
  const kind = process.env.ZY_CODE_ENVIRONMENT_KIND
  if (kind === 'byoc' || kind === 'anthropic_cloud') {
    return kind
  }
  return null
}

function hasParentPath(entry: object): entry is { parentPath: string; name: string } {
  return 'parentPath' in entry && typeof entry.parentPath === 'string'
}

function hasPath(entry: object): entry is { path: string; name: string } {
  return 'path' in entry && typeof entry.path === 'string'
}

function getEntryParentPath(entry: object, fallback: string): string {
  if (hasParentPath(entry)) {
    return entry.parentPath
  }
  if (hasPath(entry)) {
    return entry.path
  }
  return fallback
}

/**
 * Find files that have been modified since the turn started.
 * Returns paths of files with mtime >= turnStartTime.
 *
 * Uses recursive directory listing and parallelized stat calls for efficiency.
 *
 * @param turnStartTime - The timestamp when the turn started
 * @param outputsDir - The directory to scan for modified files
 */
export async function findModifiedFiles(
  turnStartTime: TurnStartTime,
  outputsDir: string,
): Promise<string[]> {
  // Use recursive flag to get all entries in one call
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    // @ts-expect-error
    entries = await fs.readdir(outputsDir, {
      withFileTypes: true,
      recursive: true,
    })
  } catch {
    // Directory doesn't exist or is not accessible
    return []
  }

  // Filter to regular files only (skip symlinks for security) and build full paths
  const filePaths: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue
    }
    if (entry.isFile()) {
      // entry.parentPath is available in Node 20+, fallback to entry.path for older versions
      const parentPath = getEntryParentPath(entry, outputsDir)
      // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
      filePaths.push(path.join(parentPath, (entry as any).name))
    }
  }

  if (filePaths.length === 0) {
    logDebug('No files found in outputs directory')
    return []
  }

  // Parallelize stat calls for all files
  const statResults = await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        const stat = await fs.lstat(filePath)
        // Skip if it became a symlink between readdir and stat (race condition)
        if (stat.isSymbolicLink()) {
          return null
        }
        return { filePath, mtimeMs: stat.mtimeMs }
      } catch {
        // File may have been deleted between readdir and stat
        return null
      }
    }),
  )

  // Filter to files modified since turn start
  const modifiedFiles: string[] = []
  for (const result of statResults) {
    // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
    if (result && result.mtimeMs >= (turnStartTime as any)) {
      modifiedFiles.push(result.filePath)
    }
  }

  logDebug(
    `Found ${modifiedFiles.length} modified files since turn start (scanned ${filePaths.length} total)`,
  )

  return modifiedFiles
}
