import { feature } from 'bun:bundle'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, normalize, posix, sep } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memdir/paths.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { getCwd } from '../environment/cwd.js'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../../services/infra/fsOperations.js'
import { containsPathTraversal, expandPath, sanitizePath } from '../../utils/path.js'
import { getPlanSlug, getPlansDirectory } from '../plans/plans.js'
import { getToolResultsDir } from '../../services/mcp/toolResultStorage.js'
import { getPlatform } from '../shell/platform.js'
import { getProjectDir } from '../sessionStorage.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsFilePathForSource, getSettingsRootPathForSource } from '../settings/settings.js'
import { windowsPathToPosixPath } from '../shell/windowsPaths.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import type { PermissionResult } from './permissionResult.js'
import type { PermissionRuleSource } from './permissionRule.js'

declare const MACRO: { VERSION: string }

const DIR_SEP = posix.sep

export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

export function getZySkillScope(filePath: string): { skillName: string; pattern: string } | null {
  const absolutePath = expandPath(filePath)
  const absolutePathLower = normalizeCaseForComparison(absolutePath)

  const bases = [
    {
      dir: expandPath(join(getOriginalCwd(), '.zy', 'skills')),
      prefix: '/.zy/skills/',
    },
    {
      dir: expandPath(join(homedir(), '.zy', 'skills')),
      prefix: '~/.zy/skills/',
    },
  ]

  for (const { dir, prefix } of bases) {
    const dirLower = normalizeCaseForComparison(dir)
    for (const pathSeparator of [sep, '/']) {
      if (absolutePathLower.startsWith(dirLower + pathSeparator.toLowerCase())) {
        const rest = absolutePath.slice(dir.length + pathSeparator.length)
        const slash = rest.indexOf('/')
        const backslash = sep === '\\' ? rest.indexOf('\\') : -1
        const cut = slash === -1 ? backslash : backslash === -1 ? slash : Math.min(slash, backslash)
        if (cut <= 0) {
          return null
        }
        const skillName = rest.slice(0, cut)
        if (!skillName || skillName === '.' || skillName.includes('..')) {
          return null
        }
        if (/[*?[\]]/.test(skillName)) {
          return null
        }
        return { skillName, pattern: `${prefix + skillName}/**` }
      }
    }
  }

  return null
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

function getSettingsPaths(): string[] {
  return SETTING_SOURCES.map((source) => getSettingsFilePathForSource(source)).filter(
    (path) => path !== undefined,
  )
}

export function isZySettingsPath(filePath: string): boolean {
  const expandedPath = expandPath(filePath)
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  if (
    normalizedPath.endsWith(`${sep}.zy${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}.zy${sep}settings.local.json`)
  ) {
    return true
  }
  return getSettingsPaths().some(
    (settingsPath) => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

function isZyConfigFilePath(filePath: string): boolean {
  if (isZySettingsPath(filePath)) {
    return true
  }

  const commandsDir = join(getOriginalCwd(), '.zy', 'commands')
  const agentsDir = join(getOriginalCwd(), '.zy', 'agents')
  const skillsDir = join(getOriginalCwd(), '.zy', 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

function isSessionPlanFile(absolutePath: string): boolean {
  const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(expectedPrefix) && normalizedPath.endsWith('.md')
}

export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}

function isSessionMemoryPath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getSessionMemoryDir())
}

function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  const normalizedPath = normalize(absolutePath)
  return normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
}

export function isScratchpadEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_scratch_dir')
}

export function getZyTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'zy'
  }
  const uid = process.getuid?.() ?? 0
  return `zy-${uid}`
}

export const getZyTempDir = memoize(function getZyTempDir(): string {
  const baseTmpDir = process.env.ZY_CODE_TMPDIR || (getPlatform() === 'windows' ? tmpdir() : '/tmp')

  const fs = getFsImplementation()
  let resolvedBaseTmpDir = baseTmpDir
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // 如果解析失败，使用原始路径
  }

  return join(resolvedBaseTmpDir, getZyTempDirName()) + sep
})

export const getBundledSkillsRoot = memoize(function getBundledSkillsRoot(): string {
  const nonce = randomBytes(16).toString('hex')
  return join(getZyTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
})

export function getProjectTempDir(): string {
  return join(getZyTempDir(), sanitizePath(getOriginalCwd())) + sep
}

export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()
  await fs.mkdir(scratchpadDir, { mode: 0o700 })
  return scratchpadDir
}

function isScratchpadPath(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  const normalizedPath = normalize(absolutePath)
  return normalizedPath === scratchpadDir || normalizedPath.startsWith(scratchpadDir + sep)
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

export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  const normalizedPath = normalize(absolutePath)

  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  if (feature('TEMPLATES')) {
    const jobDir = process.env.CLAUDE_JOB_DIR
    if (jobDir) {
      const jobsRoot = join(getZyConfigHomeDir(), 'jobs')
      const jobDirForms = getPathsForPermissionCheck(jobDir).map(normalize)
      const jobsRootForms = getPathsForPermissionCheck(jobsRoot).map(normalize)
      const isUnderJobsRoot = jobDirForms.every((jobDirForm) =>
        jobsRootForms.some((jobsRootForm) => jobDirForm.startsWith(jobsRootForm + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every((targetPath) => {
          const normalizedTargetPath = normalize(targetPath)
          return jobDirForms.some(
            (jobDirForm) =>
              normalizedTargetPath === jobDirForm ||
              normalizedTargetPath.startsWith(jobDirForm + sep),
          )
        })
        if (allInsideJobDir) {
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'other',
              reason: 'Job directory files for current job are allowed for writing',
            },
          }
        }
      }
    }
  }

  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  if (
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(join(getOriginalCwd(), '.zy', 'launch.json'))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}

export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  const normalizedPath = normalize(absolutePath)

  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSeparator = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (normalizedPath === toolResultsDir || normalizedPath.startsWith(toolResultsDirWithSeparator)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  const projectTempDir = getProjectTempDir()
  if (normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  const tasksDir = join(getZyConfigHomeDir(), 'tasks') + sep
  if (normalizedPath === tasksDir.slice(0, -1) || normalizedPath.startsWith(tasksDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  const teamsReadDir = join(getZyConfigHomeDir(), 'teams') + sep
  if (normalizedPath === teamsReadDir.slice(0, -1) || normalizedPath.startsWith(teamsReadDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  const bundledSkillsRoot = getBundledSkillsRoot() + sep
  if (normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
