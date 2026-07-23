import { feature } from 'bun:bundle'
import { homedir } from 'node:os'
import { join, normalize, posix, sep } from 'node:path'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memdir/paths.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { getCwd } from '../environment/cwd.js'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { expandPath } from '../../utils/path.js'
import { getPlanSlug, getPlansDirectory } from '../plans/plans.js'
import { getToolResultsDir } from '../../services/mcp/toolResultStorage.js'
import { getProjectDir } from '../sessionStorage.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { getPathsForPermissionCheck } from '../../services/infra/fsOperations.js'
import type { PermissionResult } from './permissionResult.js'
import {
  isScratchpadEnabled,
  getScratchpadDir,
  getProjectTempDir,
  getSessionMemoryDir,
  getBundledSkillsRoot,
} from './scratchpadStorage.js'
import { normalizeCaseForComparison, pathInWorkingPath } from './internalPaths.js'

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

function isSessionPlanFile(absolutePath: string): boolean {
  const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(expectedPrefix) && normalizedPath.endsWith('.md')
}

function isSessionMemoryPath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getSessionMemoryDir())
}

function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  const normalizedPath = normalize(absolutePath)
  return normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
}

function isScratchpadPathInner(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  const normalizedPath = normalize(absolutePath)
  return normalizedPath === scratchpadDir || normalizedPath.startsWith(scratchpadDir + sep)
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

  if (isScratchpadPathInner(normalizedPath)) {
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
      const isUnderJobsRoot = jobDirForms.every((jobDirForm: string) =>
        jobsRootForms.some((jobsRootForm: string) => jobDirForm.startsWith(jobsRootForm + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every((targetPath: string) => {
          const normalizedTargetPath = normalize(targetPath)
          return jobDirForms.some(
            (jobDirForm: string) =>
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

  if (isScratchpadPathInner(normalizedPath)) {
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
