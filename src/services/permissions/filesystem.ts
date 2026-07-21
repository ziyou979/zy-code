import { feature } from 'bun:bundle'
import { homedir } from 'node:os'
import { join, normalize, posix, sep } from 'node:path'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memdir/paths.js'
import { containsVulnerableUncPath } from 'src/shell-eval/shared/readOnlyCommandValidation.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from 'src/tools/FileEditTool/constants.js'
import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import type { AnyObject, Tool, ToolPermissionContext } from '../../tools/tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { getCwd } from '../environment/cwd.js'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../../services/infra/fsOperations.js'
import {
  containsPathTraversal,
  expandPath,
  getDirectoryForPath,
  sanitizePath,
} from '../../utils/path.js'
import { getPlatform } from '../shell/platform.js'
import { windowsPathToPosixPath } from '../shell/windowsPaths.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getSettingsRootPathForSource } from '../settings/settings.js'
import type { PermissionDecision, PermissionResult } from './permissionResult.js'
import type { PermissionRule, PermissionRuleSource } from './permissionRule.js'
import { createReadRuleSuggestion } from './permissionUpdate.js'
import type { PermissionUpdate } from './permissionUpdateSchema.js'
import { getRuleByContentsForToolName } from './permissions.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  ensureScratchpadDir,
  getBundledSkillsRoot,
  getProjectTempDir,
  getScratchpadDir,
  getSessionMemoryDir,
  getSessionMemoryPath,
  getZySkillScope,
  getZyTempDir,
  getZyTempDirName,
  isScratchpadEnabled,
  isZySettingsPath,
  normalizeCaseForComparison,
  normalizePatternsToPath,
  pathInWorkingPath,
  relativePath,
  toPosixPath,
} from './filesystemPathSupport.js'

const DIR_SEP = posix.sep

export {
  ensureScratchpadDir,
  getBundledSkillsRoot,
  getProjectTempDir,
  getScratchpadDir,
  getSessionMemoryDir,
  getSessionMemoryPath,
  getZySkillScope,
  getZyTempDir,
  getZyTempDirName,
  isScratchpadEnabled,
  isZySettingsPath,
  normalizeCaseForComparison,
  normalizePatternsToPath,
  pathInWorkingPath,
  relativePath,
  toPosixPath,
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

/**
 * 不应在 auto 模式下自动编辑的危险文件。
 * 这些文件可用于代码执行或数据泄露。
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.zy.json',
] as const

/**
 * 不应在 auto 模式下自动编辑的危险目录。
 * 这些目录包含敏感配置或可执行文件。
 */
export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.zy'] as const

/**
 * 检查文件路径在没有显式权限的情况下对 auto 编辑是否危险。
 * 包括：
 * - .git 目录或 .gitconfig 文件中的文件（防止基于 git 的数据泄露和代码执行）
 * - .vscode 目录中的文件（防止 VS Code 设置操纵和潜在代码执行）
 * - .idea 目录中的文件（防止 JetBrains IDE 设置操纵）
 * - shell 配置文件（防止 shell 启动脚本操纵）
 * - UNC 路径（防止网络文件访问和 WebDAV 攻击）
 */
function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // 检查 UNC 路径（纵深防御，捕获 containsVulnerableUncPath 可能未捕获的模式）
  // 阻止所有以 \\ 或 // 开头的内容，因为这些可能是访问网络资源的 UNC 路径
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // 检查路径是否在危险目录内（不区分大小写以防止绕过）
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // 特殊情况：.zy/worktrees/ 是结构性路径（ZY 存储 git worktree 的地方），
      // 而非用户创建的危险目录。当后面跟着 'worktrees' 时跳过 .zy 段。
      // worktree 内任何嵌套的 .zy 目录（后面不跟 'worktrees'）仍然被阻止。
      if (dir === '.zy') {
        const nextSegment = pathSegments[i + 1]
        if (nextSegment && normalizeCaseForComparison(nextSegment) === 'worktrees') {
          break // 跳过此 .zy，继续检查其他段
        }
      }

      return true
    }
  }

  // 检查危险的配置文件（不区分大小写）
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        (dangerousFile) => normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * 检测可能绕过安全检查的可疑 Windows 路径模式。
 * 这些模式包括：
 * - NTFS 备用数据流（例如 file.txt::$DATA 或 file.txt:stream）
 * - 8.3 短名称（例如 GIT~1、CLAUDE~1、SETTIN~1.JSON）
 * - 长路径前缀（例如 \\?\C:\...、\\.\C:\...、//?/C:/...、//./C:/...）
 * - 尾部点和空格（例如 .git.、.zy 、.bashrc...）
 * - DOS 设备名称（例如 .git.CON、settings.json.PRN、.bashrc.AUX）
 * - 三个或更多连续点（例如 .../file.txt、path/.../file、file...txt）
 *
 * 检测到这些路径时，应始终要求手动审批，以防止
 * 通过路径规范化漏洞绕过安全检查。
 *
 * ## 为什么在所有平台上检查？
 *
 * 虽然这些模式主要是 Windows 特有的，但 NTFS 文件系统可以挂载到
 * Linux 和 macOS 上（例如使用 ntfs-3g）。在这些系统上，相同的
 * 绕过技术也会生效 — 攻击者可以使用短名称或长路径前缀来绕过安全检查。
 * 因此，我们在所有平台上检查这些模式以确保全面保护。
 * （注意：ADS 冒号检查仅限 Windows/WSL，因为冒号语法仅由 Windows
 * 内核解释；在 Linux/macOS 上，NTFS ADS 通过 xattrs 访问，而非冒号语法。）
 *
 * ## 为什么选择检测而非规范化？
 *
 * 另一种方法是使用 Windows API（例如 GetLongPathNameW）规范化这些路径。
 * 但这种方法面临重大挑战：
 *
 * 1. **文件系统依赖**：短路径规范化相对于文件系统中当前存在的文件。
 *    这在写入新文件时会产生问题，因为它们尚不存在且无法规范化。
 *
 * 2. **竞态条件**：规范化与实际文件访问之间的文件系统状态可能发生变化，
 *    产生 TOCTOU（检查时-使用时）漏洞。
 *
 * 3. **复杂性**：正确的规范化需要 Windows 特定的 API，处理多种边缘情况，
 *    并处理各种路径格式（UNC、设备路径等）。
 *
 * 4. **可靠性**：模式检测更可预测，不依赖于外部系统状态。
 *
 * 如果你正在考虑为这些路径添加规范化，请先联系 AppSec
 * 讨论安全影响和实现方法。
 *
 * @param path 要检查可疑模式的路径
 * @returns 如果检测到可疑 Windows 路径模式则返回 true
 */
function hasSuspiciousWindowsPathPattern(path: string): boolean {
  // 检查 NTFS 备用数据流
  // 查找位置 2 之后的 ':' 以跳过盘符（例如 C:\）
  // 示例：file.txt::$DATA、.bashrc:hidden、settings.json:stream
  // 注意：ADS 冒号语法仅由 Windows 内核解释。在 WSL 上，
  // DrvFs 挂载将文件操作路由通过 Windows 内核，因此冒号
  // 语法仍被解释为 ADS 分隔符。在 Linux/macOS（非 WSL）上，
  // 即使挂载了 NTFS，ADS 也通过 xattrs（ntfs-3g）访问，而非冒号
  // 语法，冒号是有效的文件名字符。
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  // 检查 8.3 短名称
  // 查找 '~' 后跟数字
  // 示例：GIT~1、CLAUDE~1、SETTIN~1.JSON、BASHRC~1
  if (/~\d/.test(path)) {
    return true
  }

  // 检查长路径前缀（反斜杠和正斜杠变体）
  // 示例：\\?\C:\Users\...、\\.\C:\...、//?/C:/...、//./C:/...
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  // 检查 Windows 在路径解析时去除的尾部点和空格
  // 示例：.git.、.zy 、.bashrc...、settings.json.
  // 如果 ".git" 被阻止但使用 ".git."，则可以绕过字符串匹配
  if (/[.\s]+$/.test(path)) {
    return true
  }

  // 检查 Windows 视为特殊设备的 DOS 设备名称
  // 示例：.git.CON、settings.json.PRN、.bashrc.AUX
  // 设备名称：CON、PRN、AUX、NUL、COM1-9、LPT1-9
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  // 检查三个或更多连续点（...）用作路径组件时
  // 此模式可用于绕过安全检查或造成混淆
  // 示例：.../file.txt、path/.../file
  // 仅当点前后都有路径分隔符（/ 或 \）时才阻止
  // 这允许 Next.js 捕获所有路由 [...]name] 等合法用途
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  // 检查 UNC 路径（在所有平台上进行纵深防御）
  // 示例：\\server\share、\\foo.com\file、//server/share、\\192.168.1.1\share
  // UNC 路径可以访问远程资源、泄露凭据并绕过工作目录限制
  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

/**
 * 检查路径对 auto 编辑（acceptEdits 模式）是否安全。
 * 返回路径不安全的原因信息，如果所有检查通过则返回 null。
 *
 * 此函数执行全面的安全检查，包括：
 * - 可疑 Windows 路径模式（NTFS 流、8.3 名称、长路径前缀等）
 * - Zy 配置文件（.zy/settings.json、.zy/commands/、.zy/agents/）
 * - MCP CLI 状态文件（由 ZY Code 内部管理）
 * - 危险文件（.bashrc、.gitconfig、.git/、.vscode/、.idea/ 等）
 *
 * 重要：此函数检查原始路径和解析的符号链接路径，
 * 以防止通过指向受保护文件的符号链接绕过。
 *
 * @param path 要检查安全性的路径
 * @returns 如果不安全则返回 safe=false 和 message，如果所有检查通过则返回 { safe: true }
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
): { safe: true } | { safe: false; message: string; classifierApprovable: boolean } {
  // 获取所有需要检查的路径（原始路径 + 解析的符号链接路径）
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 在所有路径上检查可疑 Windows 路径模式
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedWriteSuspiciousWindowsPath', { path }),
        classifierApprovable: false,
      }
    }
  }

  // 在所有路径上检查 Zy 配置文件
  for (const pathToCheck of pathsToCheck) {
    if (isZyConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedWritePathNotGranted', { path }),
        classifierApprovable: true,
      }
    }
  }

  // 在所有路径上检查危险文件
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedEditSensitiveFile', { path }),
        classifierApprovable: true,
      }
    }
  }

  // 所有安全检查通过
  return { safe: true }
}

export function allWorkingDirectories(context: ToolPermissionContext): Set<string> {
  return new Set([getOriginalCwd(), ...context.additionalWorkingDirectories.keys()])
}

// 工作目录在会话中稳定；缓存它们的解析形式以避免
// 在每次权限检查时重复执行 existsSync/lstatSync/realpathSync 系统调用。
// 以路径字符串为键 — getPathsForPermissionCheck 在会话内对于
// 现有目录是确定性的。
// 导出用于 test/preload.ts 缓存清除（shard-isolation）。
export const getResolvedWorkingDirPaths = memoize(getPathsForPermissionCheck)

export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  // 检查原始路径和解析的符号链接路径
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 与我们解析输入路径的方式相同地解析工作目录，以便
  // 比较是对称的。如果不这样做，解析后的输入路径
  // （例如 macOS 上的 /System/Volumes/Data/home/...）将无法匹配
  // 未解析的工作目录（/home/...），导致错误的拒绝。
  const workingPaths = Array.from(allWorkingDirectories(toolPermissionContext)).flatMap((wp) =>
    getResolvedWorkingDirPaths(wp),
  )

  // 所有路径必须在允许的工作路径内
  // 如果任何解析后的路径在外部，则拒绝访问
  return pathsToCheck.every((pathToCheck) =>
    workingPaths.some((workingPath) => pathInWorkingPath(pathToCheck, workingPath)),
  )
}

/**
 * 收集文件读权限的所有拒绝规则并返回它们的 ignore 模式
 * 每个模式必须相对于其根（map 的键）解析
 * null 键用于没有根的模式
 *
 * 这用于隐藏被 Read 拒绝规则阻止的文件。
 *
 * @param toolPermissionContext
 */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(toolPermissionContext, 'read', 'deny')
  const result = new Map<string | null, string[]>()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}

function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
): {
  relativePattern: string
  root: string | null
} {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // 以 // 开头的模式相对于 / 解析
    const patternWithoutDoubleSlash = pattern.slice(1)

    // 在 Windows 上，检查这是否为 POSIX 风格的盘符路径，如 //c/Users/...
    // 注意：UNC 路径（//server/share）不会匹配此正则，将作为
    // 根相对模式处理，将来可能需要单独处理
    if (getPlatform() === 'windows' && patternWithoutDoubleSlash.match(/^\/[a-z]\//i)) {
      // 将 POSIX 路径转换为 Windows 格式
      // 模式类似于 /c/Users/...，因此将其转换为 C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // 保持模式为 POSIX 格式，因为 relativePath 返回 POSIX 路径
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // 提取盘符根目录（C:\）和模式的其余部分
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // 以 ~/ 开头的模式相对于 homedir 解析
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // 以 / 开头的模式相对于存储设置的目录解析（不含 .zy/）
    return {
      relativePattern: pattern,
      root: rootPathForSource(source),
    }
  }
  // 未指定根，将其与其他所有模式放在一起
  // 规范化以 "./" 开头的模式以移除前缀
  // 这确保像 "./.env" 这样的模式能匹配像 ".env" 这样的文件
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // 将 Edit 工具规则应用于任何编辑文件的工具
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // 将 Read 工具规则应用于任何读取文件的工具
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(toolPermissionContext, toolName, behavior)
  // 相对于路径根据来源解析规则
  const patternsByRoot = new Map<string | null, Map<string, PermissionRule>>()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map<string, PermissionRule>()
      patternsByRoot.set(root, patternsForRoot)
    }
    // 以根为键存储规则
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  let fileAbsolutePath = expandPath(path)

  // 在 Windows 上，转换为 POSIX 格式以与权限模式匹配
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(toolPermissionContext, toolType, behavior)

  // 检查每个根中是否有匹配的模式
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // 为 ignore 库转换模式
    const patterns = Array.from(patternMap.keys()).map((pattern) => {
      let adjustedPattern = pattern

      // 移除 /** 后缀 — ignore 库将 'path' 视为同时匹配
      // 路径本身和其中的所有内容
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // 使用跨平台相对路径辅助函数处理 POSIX 风格的模式
    const relativePathStr = relativePath(root ?? getCwd(), fileAbsolutePath ?? getCwd())

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // 路径在根之外，因此忽略它
      continue
    }

    // 重要：如果传入空字符串，ig.test 会抛出异常
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // 将匹配的模式映射回原始规则
      const originalPattern = igResult.rule.pattern

      // 检查这是否是我们简化的 /** 模式
      const withWildcard = `${originalPattern}/**`
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // 未找到匹配的规则
  return null
}

/**
 * 指定工具和工具输入的读权限结果
 */
export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: tSync('permission.requestedUseToolNotGranted', { toolName: tool.name }),
    }
  }
  const path = tool.getPath(input)

  // 获取要检查的路径（包括原始路径和解析的符号链接）。
  // 在此处计算一次并传递到 checkWritePermissionForTool →
  // checkPathSafetyForAutoEdit → pathInAllowedWorkingPath，以避免对
  // 同一路径重复执行 existsSync/lstatSync/realpathSync 系统调用
  // （此前每次 Read 权限检查 = 6× = 30 次系统调用）。
  const pathsToCheck = getPathsForPermissionCheck(path)

  // 1. 纵深防御：尽早阻止 UNC 路径（在其他检查之前）
  // 这捕获以 \\ 或 // 开头的可能访问网络资源的路径
  // 这可能捕获一些 containsVulnerableUncPath 未检测到的 UNC 模式
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: tSync('permission.requestedReadUncPath', { path }),
        decisionReason: {
          type: 'other',
          reason: 'UNC path detected (defense-in-depth check)',
        },
      }
    }
  }

  // 2. 检查可疑 Windows 路径模式（纵深防御）
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        behavior: 'ask',
        message: tSync('permission.requestedReadSuspiciousWindowsPath', { path }),
        decisionReason: {
          type: 'other',
          reason:
            'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification',
        },
      }
    }
  }

  // 3. 首先检查读特定的拒绝规则 — 检查原始路径和解析的符号链接路径
  // 安全：这必须在任何放行检查（包括"编辑权限隐含读权限"）之前
  // 以防止绕过显式的读拒绝规则
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(pathToCheck, toolPermissionContext, 'read', 'deny')
    if (denyRule) {
      return {
        behavior: 'deny',
        message: tSync('permission.readPermissionDenied', { path }),
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 4. 检查读特定的 ask 规则 — 检查原始路径和解析的符号链接路径
  // 安全：这必须在隐式放行检查之前，以确保显式 ask 规则被遵守
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(pathToCheck, toolPermissionContext, 'read', 'ask')
    if (askRule) {
      return {
        behavior: 'ask',
        message: tSync('permission.requestedReadPathNotGranted', { path }),
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 5. 编辑权限隐含读权限（但仅在没有读特定的拒绝/ask 规则时）
  // 我们在读特定规则之后检查此内容，以便显式读限制优先
  const editResult = checkWritePermissionForTool(tool, input, toolPermissionContext, pathsToCheck)
  if (editResult.behavior === 'allow') {
    return editResult
  }

  // 6. 允许在工作目录中读取
  const isInWorkingDir = pathInAllowedWorkingPath(path, toolPermissionContext, pathsToCheck)
  if (isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: 'default',
      },
    }
  }

  // 7. 允许从内部 harness 路径读取（session-memory、plans、tool-results）
  const absolutePath = expandPath(path)
  const internalReadResult = checkReadableInternalPath(absolutePath, input)
  if (internalReadResult.behavior !== 'passthrough') {
    return internalReadResult
  }

  // 8. 检查放行规则
  const allowRule = matchingRuleForInput(path, toolPermissionContext, 'read', 'allow')
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 12. 默认请求权限
  // 此时，isInWorkingDir 为 false（来自步骤 #6），因此路径在允许的工作目录之外
  return {
    behavior: 'ask',
    message: tSync('permission.requestedReadPathNotGranted', { path }),
    suggestions: generateSuggestions(path, 'read', toolPermissionContext, pathsToCheck),
    decisionReason: {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories',
    },
  }
}

/**
 * 指定工具和工具输入的写权限结果。
 *
 * @param precomputedPathsToCheck - `getPathsForPermissionCheck(tool.getPath(input))`
 *   的可选缓存结果。调用者必须在同一个同步帧中从相同的 `tool`
 *   和 `input` 派生此值 — `path` 在内部重新派生用于错误消息
 *   和内部路径检查，因此过时的值会静默检查错误路径的拒绝规则。
 */
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: tSync('permission.requestedUseToolNotGranted', { toolName: tool.name }),
    }
  }
  const path = tool.getPath(input)

  // 1. 检查拒绝规则 — 检查原始路径和解析的符号链接路径
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(pathToCheck, toolPermissionContext, 'edit', 'deny')
    if (denyRule) {
      return {
        behavior: 'deny',
        message: tSync('permission.editPermissionDenied', { path }),
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 1.5. 允许写入内部可编辑路径（plan 文件、暂存目录）
  // 这必须在 isDangerousFilePathToAutoEdit 检查之前，因为 .zy 是危险目录
  const absolutePathForEdit = expandPath(path)
  const internalEditResult = checkEditableInternalPath(absolutePathForEdit, input)
  if (internalEditResult.behavior !== 'passthrough') {
    return internalEditResult
  }

  // 1.6. 在安全检查之前检查 .zy/** 放行规则
  // 这允许会话级权限绕过 .zy/ 的安全块
  // 我们仅允许会话级规则，以防止用户意外地
  // 永久授予对 .zy/ 文件夹的广泛访问。
  //
  // matchingRuleForInput 返回所有来源中的第一个匹配。如果用户
  // 在 userSettings 中也有更广泛的 Edit(.zy) 规则（例如来自 sandbox
  // write-allow 转换），则该规则会首先被找到，下方的来源检查
  // 会失败。将搜索范围限制为仅会话级规则，以便对话框中的
  // "允许 ZY 在此会话期间编辑其自身设置"选项真正有效。
  const ZyFolderAllowRule = matchingRuleForInput(
    path,
    {
      ...toolPermissionContext,
      alwaysAllowRules: {
        session: toolPermissionContext.alwaysAllowRules.session ?? [],
      },
    },
    'edit',
    'allow',
  )
  if (ZyFolderAllowRule) {
    // 检查此规则是否在 .zy/ 范围内（项目级或全局级）。
    // 接受宽泛模式（'/.zy/**'、'~/.zy/**'）和
    // 缩小模式如 '/.zy/skills/my-skill/**'，以便用户可以授予
    // 对单个技能的会话访问，而不暴露 settings.json
    // 或 hooks/。规则已通过 matchingRuleForInput 匹配路径；
    // 这是额外的范围检查。拒绝 '..' 以防止如
    // '/.zy/../**' 这样的规则将此绕过泄漏到 .zy/ 之外。
    const ruleContent = ZyFolderAllowRule.ruleValue.ruleContent
    if (
      ruleContent &&
      (ruleContent.startsWith(CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2)) ||
        ruleContent.startsWith(GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2))) &&
      !ruleContent.includes('..') &&
      ruleContent.endsWith('/**')
    ) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: ZyFolderAllowRule,
        },
      }
    }
  }

  // 1.7. 检查全面的安全验证（Windows 模式、ZY 配置、危险文件）
  // 这必须在检查放行规则之前，以防止用户意外地授予
  // 编辑受保护文件的权限
  const safetyCheck = checkPathSafetyForAutoEdit(path, pathsToCheck)
  if (!safetyCheck.safe) {
    // SDK 建议：如果在 .zy/skills/{name}/ 下，发出缩小的
    // 会话范围 addRules，步骤 1.6 将在下次调用时遵守。
    // 其他所有内容（.zy/settings.json、.git/、.vscode/、.idea/）回退到
    // generateSuggestions — 其 setMode 建议不会绕过
    // 此检查，但保留它可以避免令人惊讶的空数组。
    const skillScope = getZySkillScope(path)
    const safetySuggestions: PermissionUpdate[] = skillScope
      ? [
          {
            type: 'addRules',
            rules: [
              {
                toolName: FILE_EDIT_TOOL_NAME,
                ruleContent: skillScope.pattern,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck)
    return {
      behavior: 'ask',
      message: safetyCheck.message,
      suggestions: safetySuggestions,
      decisionReason: {
        type: 'safetyCheck',
        reason: safetyCheck.message,
        classifierApprovable: safetyCheck.classifierApprovable,
      },
    }
  }

  // 2. 检查 ask 规则 — 检查原始路径和解析的符号链接路径
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(pathToCheck, toolPermissionContext, 'edit', 'ask')
    if (askRule) {
      return {
        behavior: 'ask',
        message: tSync('permission.requestedWritePathNotGranted', { path }),
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 3. 如果在 acceptEdits 或 sandboxBashMode 模式下，允许原始 cwd 中的所有写入
  const isInWorkingDir = pathInAllowedWorkingPath(path, toolPermissionContext, pathsToCheck)
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  // 4. 检查放行规则
  const allowRule = matchingRuleForInput(path, toolPermissionContext, 'edit', 'allow')
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 5. 默认请求权限
  return {
    behavior: 'ask',
    message: tSync('permission.requestedWritePathNotGranted', { path }),
    suggestions: generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const isOutsideWorkingDir = !pathInAllowedWorkingPath(
    filePath,
    toolPermissionContext,
    precomputedPathsToCheck,
  )

  if (operationType === 'read' && isOutsideWorkingDir) {
    // 对于读操作在工作目录之外，添加 Read 规则
    // 重要：包括符号链接路径和解析路径，以便后续检查通过
    const dirPath = getDirectoryForPath(filePath)
    const dirsToAdd = getPathsForPermissionCheck(dirPath)

    const suggestions = dirsToAdd
      .map((dir) => createReadRuleSuggestion(dir, 'session'))
      .filter((s): s is PermissionUpdate => s !== undefined)

    return suggestions
  }

  // 仅在 setMode:acceptEdits 是升级时才建议。在 auto
  // 模式下，分类器已自动批准编辑；在 bypassPermissions
  // 下一切都被允许；在 acceptEdits 下这是无操作。仍然建议它
  // 并让 SDK 主机在"始终允许"时应用，会静默
  // 将 auto 降级为 acceptEdits，然后提示 MCP/Bash。
  const shouldSuggestAcceptEdits =
    toolPermissionContext.mode === 'default' || toolPermissionContext.mode === 'plan'

  if (operationType === 'write' || operationType === 'create') {
    const updates: PermissionUpdate[] = shouldSuggestAcceptEdits
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : []

    if (isOutsideWorkingDir) {
      // 对于写操作在工作目录之外，也添加目录
      // 重要：包括符号链接路径和解析路径，以便后续检查通过
      const dirPath = getDirectoryForPath(filePath)
      const dirsToAdd = getPathsForPermissionCheck(dirPath)

      updates.push({
        type: 'addDirectories',
        directories: dirsToAdd,
        destination: 'session',
      })
    }

    return updates
  }

  // 对于读操作在工作目录内，仅更改模式
  return shouldSuggestAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
}

/**
 * 检查路径是否为可以无需权限编辑的内部路径。
 * 返回 PermissionResult — 如果匹配则返回 'allow'，否则返回 'passthrough' 以继续检查。
 */
export { checkEditableInternalPath } from './filesystemPathSupport.js'

/**
 * 检查路径是否为可以无需权限读取的内部路径。
 * 返回 PermissionResult — 如果匹配则返回 'allow'，否则返回 'passthrough' 以继续检查。
 */
export { checkReadableInternalPath } from './filesystemPathSupport.js'
