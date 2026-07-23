import { posix, sep } from 'node:path'
import { expandPath } from '../../utils/path.js'
import { containsPathTraversal } from '../../utils/path.js'
import { getPlatform } from '../shell/platform.js'
import { windowsPathToPosixPath } from '../shell/windowsPaths.js'
import type { PermissionRuleSource } from './permissionRule.js'
import { getSettingsRootPathForSource } from '../settings/settings.js'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'

const DIR_SEP = posix.sep

export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

export function relativePath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    const posixFrom = windowsPathToPosixPath(from)
    const posixTo = windowsPathToPosixPath(to)
    return posix.relative(posixFrom, posixTo)
  }
  return posix.relative(from, to)
}

export function toPosixPath(path: string): string {
  if (getPlatform() === 'windows') {
    return windowsPathToPosixPath(path)
  }
  return path
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(normalizedWorkingPath)
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  if (relative === '') {
    return true
  }
  if (containsPathTraversal(relative)) {
    return false
  }
  return !posix.isAbsolute(relative)
}

function rootPathForSource(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(getOriginalCwd())
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return getSettingsRootPathForSource(source)
  }
}

function prependDirSep(path: string): string {
  return posix.join(DIR_SEP, path)
}

function normalizePatternToPath({
  patternRoot,
  pattern,
  rootPath,
}: {
  patternRoot: string
  pattern: string
  rootPath: string
}): string | null {
  const fullPattern = posix.join(patternRoot, pattern)
  if (patternRoot === rootPath) {
    return prependDirSep(pattern)
  }
  if (fullPattern.startsWith(`${rootPath}${DIR_SEP}`)) {
    const relativePart = fullPattern.slice(rootPath.length)
    return prependDirSep(relativePart)
  }

  const relativePatternPath = posix.relative(rootPath, patternRoot)
  if (
    !relativePatternPath ||
    relativePatternPath.startsWith(`..${DIR_SEP}`) ||
    relativePatternPath === '..'
  ) {
    return null
  }
  return prependDirSep(posix.join(relativePatternPath, pattern))
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  const result = new Set(patternsByRoot.get(null) ?? [])

  for (const [patternRoot, patterns] of patternsByRoot.entries()) {
    if (patternRoot === null) {
      continue
    }

    for (const pattern of patterns) {
      const normalizedPattern = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      })
      if (normalizedPattern) {
        result.add(normalizedPattern)
      }
    }
  }
  return Array.from(result)
}
