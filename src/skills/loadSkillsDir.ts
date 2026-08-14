import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep as pathSep, relative } from 'node:path'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { getAdditionalDirectoriesForAgentsMd } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { parseUserSpecifiedModel } from '../services/model/model.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Command, PromptCommand } from '../commands/types.js'
import { parseArgumentNames, substituteArguments } from '../utils/argumentParser.js'
import { logForDebugging } from '../services/infra/debug.js'
import { EFFORT_LEVELS, type EffortLevel, parseEffortValue } from '../services/effort/effort.js'
import { getZyConfigHomeDir, isBareMode, isEnvTruthy } from '../services/infra/envUtils.js'
import { isENOENT, isFsInaccessible } from '../utils/errors.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  type FrontmatterShell,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from '../services/markdown/frontmatterParser.js'
import { getFsImplementation } from '../services/infra/fsOperations.js'
import { isPathGitignored } from '../services/git/gitignore.js'
import { logError } from '../services/infra/log.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  type MarkdownFile,
  parseSlashCommandToolsFromFrontmatter,
} from '../services/markdown/markdownConfigLoader.js'
import { executeShellCommandsInPrompt } from '../services/shell/promptShellExecution.js'
import type { SettingSource } from '../services/settings/constants.js'
import { isSettingSourceEnabled } from '../services/settings/constants.js'
import { getManagedFilePath } from '../services/settings/managedPath.js'
import { isRestrictedToPluginOnly } from '../services/settings/pluginOnlyPolicy.js'
import { parseHooksFromFrontmatter } from '../services/hooks/parseHooksFromFrontmatter.js'
import type { HooksSettings } from '../services/settings/types.js'
import { createSignal } from '../utils/signal.js'
import { registerMCPSkillBuilders } from './mcpSkillBuilders.js'

export type LoadedFrom = 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'

/**
 * 返回给定来源对应的 zy 配置目录路径。
 */
export function getSkillsPath(
  source: SettingSource | 'plugin',
  dir: 'skills' | 'commands',
): string {
  switch (source) {
    case 'policySettings':
      return join(getManagedFilePath(), '.zy', dir)
    case 'userSettings':
      return join(getZyConfigHomeDir(), dir)
    case 'projectSettings':
      return `.zy/${dir}`
    case 'plugin':
      return 'plugin'
    default:
      return ''
  }
}

/**
 * 仅根据 frontmatter 估算 skill 的 token 数量。
 * (name, description, whenToUse) since full content is only loaded on invocation.
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatterText = [skill.name, skill.description, skill.whenToUse].filter(Boolean).join(' ')
  return roughTokenCountEstimation(frontmatterText)
}

/**
 * 解析 symlink 得到 canonical path，以获取文件唯一标识，从而识别经不同路径访问的重复文件。
 * (e.g., via symlinks or overlapping parent directories).
 * 文件不存在或无法解析时返回 null。
 *
 * 使用 realpath 解析 symlink，与文件系统无关，也可避开某些文件系统报告不可靠 inode
 * 的问题，例如部分虚拟/container/NFS 文件系统返回 inode 0，或 ExFAT 出现精度丢失。
 * 参见：https://github.com/anthropics/zy-code/issues/13893
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath)
  } catch {
    return null
  }
}

// 内部类型：连同文件路径跟踪 skill，用于去重
type SkillWithPath = {
  skill: Command
  filePath: string
}

/**
 * 使用与 AGENTS.md 规则相同的格式解析 skill 的 paths frontmatter。
 * 未指定路径或全部模式均匹配所有内容时返回 undefined。
 */
function parseSkillPaths(frontmatter: FrontmatterData): string[] | undefined {
  if (!frontmatter.paths) {
    return undefined
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map((pattern) => {
      // 移除 /** 后缀；ignore 库会让 'path' 同时匹配路径自身及其内部全部内容
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // 全部模式都是 **（匹配所有内容）时，视为未指定 paths（undefined）
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return undefined
  }

  return patterns
}

/**
 * 解析文件型 skill 与 MCP skill 加载流程共享的全部 frontmatter 字段。
 * 调用方另行提供解析后的 skill 名称以及 source/loadedFrom/baseDir/paths 字段。
 */
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortLevel | undefined
  shell: FrontmatterShell | undefined
} {
  const validatedDescription = coerceDescriptionToString(frontmatter.description, resolvedName)
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel)

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])

  const model =
    frontmatter.model === 'inherit'
      ? undefined
      : frontmatter.model
        ? parseUserSpecifiedModel(frontmatter.model as string)
        : undefined

  const effortRaw = frontmatter.effort
  const effort = effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined
  if (effortRaw !== undefined && effort === undefined) {
    logForDebugging(
      `Skill ${resolvedName} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
    )
  }

  return {
    displayName: frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    allowedTools: parseSlashCommandToolsFromFrontmatter(frontmatter['allowed-tools']),
    argumentHint:
      frontmatter['argument-hint'] != null ? String(frontmatter['argument-hint']) : undefined,
    argumentNames: parseArgumentNames(frontmatter.arguments as string | string[] | undefined),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(frontmatter['disable-model-invocation']),
    userInvocable,
    hooks: parseHooksFromFrontmatter(frontmatter as Record<string, unknown>, resolvedName),
    executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: frontmatter.agent as string | undefined,
    effort,
    shell: parseShellFrontmatter(frontmatter.shell, resolvedName),
  }
}

/**
 * 从解析后的数据创建 skill command。
 */
export function createSkillCommand({
  skillName,
  displayName,
  description,
  hasUserSpecifiedDescription,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  hooks,
  executionContext,
  agent,
  paths,
  effort,
  shell,
}: {
  skillName: string
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  markdownContent: string
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  source: PromptCommand['source']
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  hooks: HooksSettings | undefined
  executionContext: 'inline' | 'fork' | undefined
  agent: string | undefined
  paths: string[] | undefined
  effort: EffortLevel | undefined
  shell: FrontmatterShell | undefined
}): Command {
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    disableModelInvocation,
    userInvocable,
    context: executionContext,
    agent,
    effort,
    paths,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    userFacingName(): string {
      return displayName || skillName
    },
    source,
    loadedFrom,
    hooks,
    skillRoot: baseDir,
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      finalContent = substituteArguments(finalContent, args, true, argumentNames)

      // 将 ${CLAUDE_SKILL_DIR} 替换为 skill 自身目录，使 bash 注入（!`...`）可引用
      // 内置脚本。Windows 上把反斜杠归一化为正斜杠，避免 shell 命令把它们当作转义符。
      if (baseDir) {
        const skillDir = process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // 将 ${CLAUDE_SESSION_ID} 替换为当前 session ID
      finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

      // 安全边界：MCP skill 来自远程且不可信，绝不执行其 Markdown 正文中的内联
      // shell 命令（!`…` / ```! … ```）。
      // ${CLAUDE_SKILL_DIR} is meaningless for MCP skills anyway.
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          {
            ...toolUseContext,
            getAppState() {
              const appState = toolUseContext.getAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: allowedTools,
                  },
                },
              }
            },
          },
          `/${skillName}`,
          shell,
        )
      }

      return [{ type: 'text', text: finalContent }]
    },
  } satisfies Command
}

/**
 * 从 /skills/ 目录加载 skill，只支持目录格式：skill-name/SKILL.md。
 */
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  const fs = getFsImplementation()

  let entries
  try {
    entries = await fs.readdir(basePath)
  } catch (e: unknown) {
    if (!isFsInaccessible(e)) {
      logError(e)
    }
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillWithPath | null> => {
      try {
        // 只支持目录格式：skill-name/SKILL.md
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          // /skills/ 目录不支持单独的 .md 文件
          return null
        }

        const skillDirPath = join(basePath, entry.name)
        const skillFilePath = join(skillDirPath, 'SKILL.md')

        let content: string
        try {
          content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
        } catch (e: unknown) {
          // SKILL.md 不存在时跳过；非 ENOENT 错误需记录日志
          // (EACCES/EPERM/EIO) so permission/IO problems are diagnosable.
          if (!isENOENT(e)) {
            logForDebugging(`[skills] failed to read ${skillFilePath}: ${e}`, {
              level: 'warn',
            })
          }
          return null
        }

        const { frontmatter, content: markdownContent } = parseFrontmatter(content, skillFilePath)

        const skillName = entry.name
        const parsed = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)
        const paths = parseSkillPaths(frontmatter)

        return {
          skill: createSkillCommand({
            ...parsed,
            skillName,
            markdownContent,
            source,
            baseDir: skillDirPath,
            loadedFrom: 'skills',
            paths,
          }),
          filePath: skillFilePath,
        }
      } catch (error) {
        logError(error)
        return null
      }
    }),
  )

  return results.filter((r): r is SkillWithPath => r !== null)
}

// --- Legacy /commands/ loader ---

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath))
}

/**
 * 转换 Markdown 文件，以处理旧版 /commands/ 目录中的“skill”命令。
 * 目录内存在 SKILL.md 时只加载该文件，并使用其父目录名称。
 */
function transformSkillFiles(files: MarkdownFile[]): MarkdownFile[] {
  const filesByDir = new Map<string, MarkdownFile[]>()

  for (const file of files) {
    const dir = dirname(file.filePath)
    const dirFiles = filesByDir.get(dir) ?? []
    dirFiles.push(file)
    filesByDir.set(dir, dirFiles)
  }

  const result: MarkdownFile[] = []

  for (const [dir, dirFiles] of filesByDir) {
    const skillFiles = dirFiles.filter((f) => isSkillFile(f.filePath))
    if (skillFiles.length > 0) {
      const skillFile = skillFiles[0]!
      if (skillFiles.length > 1) {
        logForDebugging(
          `Multiple skill files found in ${dir}, using ${basename(skillFile.filePath)}`,
        )
      }
      result.push(skillFile)
    } else {
      result.push(...dirFiles)
    }
  }

  return result
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBaseDir = baseDir.endsWith(pathSep) ? baseDir.slice(0, -1) : baseDir

  if (targetDir === normalizedBaseDir) {
    return ''
  }

  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(pathSep).join(':') : ''
}

function getSkillCommandName(filePath: string, baseDir: string): string {
  const skillDirectory = dirname(filePath)
  const parentOfSkillDir = dirname(skillDirectory)
  const commandBaseName = basename(skillDirectory)

  const namespace = buildNamespace(parentOfSkillDir, baseDir)
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
}

function getRegularCommandName(filePath: string, baseDir: string): string {
  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const commandBaseName = fileName.replace(/\.md$/, '')

  const namespace = buildNamespace(fileDirectory, baseDir)
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
}

function getCommandName(file: MarkdownFile): string {
  const isSkill = isSkillFile(file.filePath)
  return isSkill
    ? getSkillCommandName(file.filePath, file.baseDir)
    : getRegularCommandName(file.filePath, file.baseDir)
}

/**
 * 从旧版 /commands/ 目录加载 skill。支持目录格式（SKILL.md）和单个 .md 文件格式。
 * /commands/ 中的命令默认 user-invocable: true。
 */
async function loadSkillsFromCommandsDir(cwd: string): Promise<SkillWithPath[]> {
  try {
    const markdownFiles = await loadMarkdownFilesForSubdir('commands', cwd)
    const processedFiles = transformSkillFiles(markdownFiles)

    const skills: SkillWithPath[] = []

    for (const { baseDir, filePath, frontmatter, content, source } of processedFiles) {
      try {
        const isSkillFormat = isSkillFile(filePath)
        const skillDirectory = isSkillFormat ? dirname(filePath) : undefined
        const cmdName = getCommandName({
          baseDir,
          filePath,
          frontmatter,
          content,
          source,
        })

        const parsed = parseSkillFrontmatterFields(frontmatter, content, cmdName, 'Custom command')

        skills.push({
          skill: createSkillCommand({
            ...parsed,
            skillName: cmdName,
            displayName: undefined,
            markdownContent: content,
            source,
            baseDir: skillDirectory,
            loadedFrom: 'commands_DEPRECATED',
            paths: undefined,
          }),
          filePath,
        })
      } catch (error) {
        logError(error)
      }
    }

    return skills
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 从 /skills/ 与旧版 /commands/ 目录加载全部 skill。
 *
 * 来自 /skills/ 目录的 skill：
 * - Only support directory format: skill-name/SKILL.md
 * - Default to user-invocable: true (can opt-out with user-invocable: false)
 *
 * 来自旧版 /commands/ 目录的 skill：
 * - Support both directory format (SKILL.md) and single .md file format
 * - Default to user-invocable: true (user can type /cmd)
 *
 * @param cwd Current working directory for project directory traversal
 */
export const getSkillDirCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const userSkillsDir = join(getZyConfigHomeDir(), 'skills')
  const managedSkillsDir = join(getManagedFilePath(), '.zy', 'skills')
  const projectSkillsDirs = getProjectDirsUpToHome('skills', cwd)

  logForDebugging(
    `Loading skills from: managed=${managedSkillsDir}, user=${userSkillsDir}, project=[${projectSkillsDirs.join(', ')}]`,
  )

  // 从附加目录（--add-dir）加载
  const additionalDirs = getAdditionalDirectoriesForAgentsMd()
  const skillsLocked = isRestrictedToPluginOnly('skills')
  const projectSettingsEnabled = isSettingSourceEnabled('projectSettings') && !skillsLocked

  // --bare: skip auto-discovery (managed/user/project dir walks + legacy
  // commands-dir）。只加载显式 --add-dir 路径；内置 skill 会另行注册。
  // skillsLocked 仍然生效，--bare 不能绕过 policy。
  if (isBareMode()) {
    if (additionalDirs.length === 0 || !projectSettingsEnabled) {
      logForDebugging(
        `[bare] Skipping skill dir discovery (${additionalDirs.length === 0 ? 'no --add-dir' : 'projectSettings disabled or skillsLocked'})`,
      )
      return []
    }
    const additionalSkillsNested = await Promise.all(
      additionalDirs.map((dir) =>
        loadSkillsFromSkillsDir(join(dir, '.zy', 'skills'), 'projectSettings'),
      ),
    )
    // 无需去重；这些目录由用户显式指定，唯一性由用户控制
    return additionalSkillsNested.flat().map((s) => s.skill)
  }

  // 并行加载 /skills/、附加目录及旧版 /commands/
  // (all independent — different directories, no shared state)
  const [managedSkills, userSkills, projectSkillsNested, additionalSkillsNested, legacyCommands] =
    await Promise.all([
      isEnvTruthy(process.env.ZY_CODE_DISABLE_POLICY_SKILLS)
        ? Promise.resolve([])
        : loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
      isSettingSourceEnabled('userSettings') && !skillsLocked
        ? loadSkillsFromSkillsDir(userSkillsDir, 'userSettings')
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            projectSkillsDirs.map((dir) => loadSkillsFromSkillsDir(dir, 'projectSettings')),
          )
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            additionalDirs.map((dir) =>
              loadSkillsFromSkillsDir(join(dir, '.zy', 'skills'), 'projectSettings'),
            ),
          )
        : Promise.resolve([]),
      // 旧版 commands-as-skills 会经 markdownConfigLoader 且 subdir='commands'，
      // 那里的 agents-only 保护会跳过它们。skills 被锁定时需在此阻止；无论从哪个
      // 目录加载，它们本质上都是 skill。
      skillsLocked ? Promise.resolve([]) : loadSkillsFromCommandsDir(cwd),
    ])

  // 展平并合并全部 skill
  const allSkillsWithPaths = [
    ...managedSkills,
    ...userSkills,
    ...projectSkillsNested.flat(),
    ...additionalSkillsNested.flat(),
    ...legacyCommands,
  ]

  // 按解析后的路径去重，以处理 symlink 和重复父目录。先并行预计算文件标识
  //（realpath 调用相互独立），再同步去重；结果依赖顺序，首项优先。
  const fileIds = await Promise.all(
    allSkillsWithPaths.map(({ skill, filePath }) =>
      skill.type === 'prompt' ? getFileIdentity(filePath) : Promise.resolve(null),
    ),
  )

  const seenFileIds = new Map<string, SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'>()
  const deduplicatedSkills: Command[] = []

  for (let i = 0; i < allSkillsWithPaths.length; i++) {
    const entry = allSkillsWithPaths[i]
    if (entry === undefined || entry.skill.type !== 'prompt') {
      continue
    }
    const { skill } = entry

    const fileId = fileIds[i]
    if (fileId === null || fileId === undefined) {
      deduplicatedSkills.push(skill)
      continue
    }

    const existingSource = seenFileIds.get(fileId)
    if (existingSource !== undefined) {
      logForDebugging(
        `Skipping duplicate skill '${skill.name}' from ${skill.source} (same file already loaded from ${existingSource})`,
      )
      continue
    }

    seenFileIds.set(fileId, skill.source)
    deduplicatedSkills.push(skill)
  }

  const duplicatesRemoved = allSkillsWithPaths.length - deduplicatedSkills.length
  if (duplicatesRemoved > 0) {
    logForDebugging(`Deduplicated ${duplicatesRemoved} skills (same file)`)
  }

  // 将带 paths frontmatter 的条件 skill 与无条件 skill 分开
  const unconditionalSkills: Command[] = []
  const newConditionalSkills: Command[] = []
  for (const skill of deduplicatedSkills) {
    if (
      skill.type === 'prompt' &&
      skill.paths &&
      skill.paths.length > 0 &&
      !activatedConditionalSkillNames.has(skill.name)
    ) {
      newConditionalSkills.push(skill)
    } else {
      unconditionalSkills.push(skill)
    }
  }

  // 保存条件 skill，待触及匹配文件时激活
  for (const skill of newConditionalSkills) {
    conditionalSkills.set(skill.name, skill)
  }

  if (newConditionalSkills.length > 0) {
    logForDebugging(
      `[skills] ${newConditionalSkills.length} conditional skills stored (activated when matching files are touched)`,
    )
  }

  logForDebugging(
    `Loaded ${deduplicatedSkills.length} unique skills (${unconditionalSkills.length} unconditional, ${newConditionalSkills.length} conditional, managed: ${managedSkills.length}, user: ${userSkills.length}, project: ${projectSkillsNested.flat().length}, additional: ${additionalSkillsNested.flat().length}, legacy commands: ${legacyCommands.length})`,
  )

  return unconditionalSkills
})

export function clearSkillCaches() {
  getSkillDirCommands.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}

// 测试使用的向后兼容别名
export {
  clearSkillCaches as clearCommandCaches,
  getSkillDirCommands as getCommandDirCommands,
  transformSkillFiles,
}

// --- Dynamic skill discovery ---

// 动态发现 skill 的 state
const dynamicSkillDirs = new Set<string>()
const dynamicSkills = new Map<string, Command>()

// --- Conditional skills (path-filtered) ---

// 带 paths frontmatter、尚未激活的 skill
let conditionalSkills: Map<string, Command>
conditionalSkills = new Map<string, Command>()
// 已激活 skill 的名称，在同一 session 清除缓存后仍保留
let activatedConditionalSkillNames: Set<string>
activatedConditionalSkillNames = new Set<string>()

// 动态 skill 加载后触发的 signal
const skillsLoaded = createSignal()

/**
 * 注册动态 skill 加载后调用的 callback。供其他模块在不形成 import cycle 的情况下
 * 清理缓存；返回取消订阅函数。
 */
export function onDynamicSkillsLoaded(callback: () => void): () => void {
  // 订阅时包装 listener，使抛错的 listener 被记录并跳过，而不是中断
  // skillsLoaded.emit()、破坏 skill 加载。与 growthbook.ts 的 callSafe 模式相同；
  // createSignal.emit() 不会为每个 listener 单独 try/catch。
  return skillsLoaded.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}

/**
 * 从文件路径向上遍历到 cwd，发现 skill 目录。只发现 cwd 以下的目录，
 * cwd 级 skill 已在启动时加载。
 *
 * @param filePaths Array of file paths to check
 * @param cwd Current working directory (upper bound for discovery)
 * @returns Array of newly discovered skill directories, sorted deepest first
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const fs = getFsImplementation()
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    // 从文件父目录开始
    let currentDir = dirname(filePath)

    // 向上遍历到 cwd，但不包含 cwd 本身。cwd 级 skill 已在启动时加载，因此只发现嵌套项。
    // 使用前缀加分隔符检查，避免 cwd 为 /project 时误匹配 /project-backup
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.zy', 'skills')

      // 无论之前命中与否，只要检查过该路径就跳过。目录不存在是常见情况，这可避免
      // 每次 Read/Write/Edit 调用都重复执行同一个失败的 stat。
      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)
        try {
          await fs.stat(skillDir)
          // skill 目录存在。加载前检查其所在目录是否被 gitignore，防止例如
          // node_modules/pkg/.zy/skills 被静默加载。`git check-ignore` 可处理嵌套 .gitignore，
          // .git/info/exclude, and global gitignore. Fails open outside a
          // 非 git repo 会以 exit 128 → false 返回；调用时的信任对话框才是真正安全边界。
          if (await isPathGitignored(currentDir, resolvedCwd)) {
            logForDebugging(`[skills] Skipped gitignored skills dir: ${skillDir}`)
            continue
          }
          newDirs.push(skillDir)
        } catch {
          // 目录不存在，已在上方记录，继续
        }
      }

      // 移至父目录
      const parent = dirname(currentDir)
      if (parent === currentDir) {
        break // Reached root
      }
      currentDir = parent
    }
  }

  // 按路径深度排序，最深优先，使距离文件更近的 skill 获得更高优先级
  return newDirs.sort((a, b) => b.split(pathSep).length - a.split(pathSep).length)
}

/**
 * 从给定目录加载 skill 并合并到动态 skill map；离文件更近、路径更深的目录优先。
 *
 * @param dirs Array of skill directories to load from (should be sorted deepest first)
 */
export async function addSkillDirectories(dirs: string[]): Promise<void> {
  if (!isSettingSourceEnabled('projectSettings') || isRestrictedToPluginOnly('skills')) {
    logForDebugging(
      '[skills] Dynamic skill discovery skipped: projectSettings disabled or plugin-only policy',
    )
    return
  }
  if (dirs.length === 0) {
    return
  }

  const previousSkillNamesForLogging = new Set(dynamicSkills.keys())

  // 从全部目录加载 skill
  const loadedSkills = await Promise.all(
    dirs.map((dir) => loadSkillsFromSkillsDir(dir, 'projectSettings')),
  )

  // 逆序处理，先浅后深，使深层路径覆盖浅层路径
  for (let i = loadedSkills.length - 1; i >= 0; i--) {
    for (const { skill } of loadedSkills[i] ?? []) {
      if (skill.type === 'prompt') {
        dynamicSkills.set(skill.name, skill)
      }
    }
  }

  const newSkillCount = loadedSkills.flat().length
  if (newSkillCount > 0) {
    const addedSkills = [...dynamicSkills.keys()].filter(
      (n) => !previousSkillNamesForLogging.has(n),
    )
    logForDebugging(
      `[skills] Dynamically discovered ${newSkillCount} skills from ${dirs.length} directories`,
    )
    if (addedSkills.length > 0) {
      logEvent('zy_dynamic_skills_changed', {
        source: 'file_operation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        previousCount: previousSkillNamesForLogging.size,
        newCount: dynamicSkills.size,
        addedCount: addedSkills.length,
        directoryCount: dirs.length,
      })
    }
  }

  // 通知 listener skill 已加载，使其能够清理缓存
  skillsLoaded.emit()
}

/**
 * 获取 session 期间从文件路径动态发现的全部 skill。
 */
export function getDynamicSkills(): Command[] {
  return Array.from(dynamicSkills.values())
}

/**
 * 激活路径模式与给定文件路径匹配的条件 skill（带 paths frontmatter 的 skill）。
 * 激活后加入动态 skill map，使模型可以使用。
 *
 * 使用 `ignore` 库进行 gitignore 风格匹配，与 AGENTS.md 条件规则的行为一致。
 *
 * @param filePaths Array of file paths being operated on
 * @param cwd Current working directory (paths are matched relative to cwd)
 * @returns Array of newly activated skill names
 */
export function activateConditionalSkillsForPaths(filePaths: string[], cwd: string): string[] {
  if (conditionalSkills.size === 0) {
    return []
  }

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (skill.type !== 'prompt' || !skill.paths || skill.paths.length === 0) {
      continue
    }

    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath

      // ignore() 遇到空字符串、越出 base 的路径（../）和绝对路径时会抛错；
      // Windows 跨盘 relative() 会返回绝对路径。cwd 外文件本来也无法匹配 cwd 相对模式。
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        continue
      }

      if (skillIgnore.ignores(relativePath)) {
        // 将 skill 移入动态 skill 集合以激活
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        logForDebugging(
          `[skills] Activated conditional skill '${name}' (matched path: ${relativePath})`,
        )
        break
      }
    }
  }

  if (activated.length > 0) {
    logEvent('zy_dynamic_skills_changed', {
      source: 'conditional_paths' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      previousCount: dynamicSkills.size - activated.length,
      newCount: dynamicSkills.size,
      addedCount: activated.length,
      directoryCount: 0,
    })

    // 通知 listener skill 已加载，使其能够清理缓存
    skillsLoaded.emit()
  }

  return activated
}

/**
 * 获取待处理条件 skill 数量，供测试和调试使用。
 */
export function getConditionalSkillCount(): number {
  return conditionalSkills.size
}

/**
 * 清除动态 skill state，供测试使用。
 */
export function clearDynamicSkills(): void {
  dynamicSkillDirs.clear()
  dynamicSkills.clear()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}

// 通过叶节点 registry 模块向 MCP skill 发现流程公开 createSkillCommand 和
// parseSkillFrontmatterFields。为何需要此间接层见 mcpSkillBuilders.ts：从 mcpSkills.ts
// 使用字面量动态 import 会把一条边扩散成多处循环依赖违规；变量 specifier 的动态
// import 虽可通过 dep-cruiser，却无法在 Bun bundle 后的二进制中于运行时解析。
// eslint-disable-next-line custom-rules/no-top-level-side-effects -- write-once registration, idempotent
registerMCPSkillBuilders({
  createSkillCommand,
  parseSkillFrontmatterFields,
})
