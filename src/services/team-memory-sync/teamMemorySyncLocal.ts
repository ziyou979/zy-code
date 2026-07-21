/**
 * 团队记忆同步本地文件读写。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  getTeamMemPath,
  PathTraversalError,
  validateTeamMemKey,
} from '../../memdir/teamMemPaths.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logEvent } from '../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import { scanForSecrets } from './secretScanner.js'
import type { SkippedSecretFile } from './types.js'
import { isErrnoException, MAX_FILE_SIZE_BYTES } from './teamMemorySyncShared.js'

export async function readLocalTeamMemory(maxEntries: number | null): Promise<{
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

              const secretMatches = scanForSecrets(content)
              if (secretMatches.length > 0) {
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

export async function writeRemoteEntriesToLocal(entries: Record<string, string>): Promise<number> {
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

export function buildSkippedSecretsAnalyticsValue(
  skippedSecrets: SkippedSecretFile[],
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return skippedSecrets
    .map((secret) => secret.ruleId)
    .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
