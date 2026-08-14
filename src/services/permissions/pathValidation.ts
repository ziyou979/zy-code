import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { SandboxManager } from 'src/services/sandbox/sandboxAdapter.js'
import { containsVulnerableUncPath } from 'src/shell-eval/shared/readOnlyCommandValidation.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
  safeResolvePath,
} from '../../services/infra/fsOperations.js'
import { containsPathTraversal } from '../../utils/path.js'
import { getPlatform } from '../shell/platform.js'
import { checkPathSafetyForAutoEdit } from './autoEditPathSafety.js'
import { matchingRuleForInput, pathInAllowedWorkingPath } from './filesystem.js'
import { checkEditableInternalPath, checkReadableInternalPath } from './filesystemPolicy.js'
import { pathInWorkingPath } from './internalPaths.js'

const MAX_DIRS_TO_LIST = 5
const GLOB_PATTERN_REGEX = /[*?[\]{}]/

export type FileOperationType = 'read' | 'write' | 'create'

export type PathCheckResult = {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}

export type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

export function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length

  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map((dir) => `'${dir}'`).join(', ')
  }

  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map((dir) => `'${dir}'`)
    .join(', ')

  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`
}

/**
 * 从 glob 模式中提取基础目录供校验。例如 "/path/to/*.txt" 返回 "/path/to"。
 */
export function getGlobBaseDirectory(path: string): string {
  const globMatch = path.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return path
  }

  // 获取首个 glob 字符之前的内容
  const beforeGlob = path.substring(0, globMatch.index)

  // 查找最后一个目录分隔符
  const lastSepIndex =
    getPlatform() === 'windows'
      ? Math.max(beforeGlob.lastIndexOf('/'), beforeGlob.lastIndexOf('\\'))
      : beforeGlob.lastIndexOf('/')
  if (lastSepIndex === -1) {
    return '.'
  }

  return beforeGlob.substring(0, lastSepIndex) || '/'
}

/**
 * 将路径开头的波浪号（~）展开为用户主目录。出于安全考虑，不支持 ~username 展开。
 */
export function expandTilde(path: string): string {
  if (
    path === '~' ||
    path.startsWith('~/') ||
    (process.platform === 'win32' && path.startsWith('~\\'))
  ) {
    return homedir() + path.slice(1)
  }
  return path
}

/**
 * 根据 sandbox 写入 allowlist 检查解析后的路径是否可写。启用 sandbox 时，用户已明确配置
 * 可写目录；路径校验将它们视为额外允许写入的目录。因此 /tmp/zy/ 已在 allowlist 中时，
 * `echo foo > /tmp/zy/x.txt` 等命令无需再次请求权限。
 *
 * 同时遵守 allow 内部的 deny 列表：即使父目录位于 allowOnly，denyWithinAllow 中的
 * .zy/settings.json 等路径仍会被阻止。
 */
export function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }
  const { allowOnly, denyWithinAllow } = SandboxManager.getFsWriteConfig()
  // 对比较两侧都解析 symlink，使比较对称，与 pathInAllowedWorkingPath 一致。否则 allowlist
  // 中的 symlink（如 /home/user/proj -> /data/proj）无法匹配对解析后目标的写入，造成不必要
  // 的权限询问；这只是过度保守，并非安全问题。所有解析后的输入表示都必须被允许，且不能有
  // 任一被拒绝。配置路径在会话中稳定，因此记忆化解析结果，避免含 N 个写入目标的命令产生
  // N × config.length 次冗余 syscall，与 getResolvedWorkingDirPaths 的做法一致。
  const pathsToCheck = getPathsForPermissionCheck(resolvedPath)
  const resolvedAllow = allowOnly.flatMap(getResolvedSandboxConfigPath)
  const resolvedDeny = denyWithinAllow.flatMap(getResolvedSandboxConfigPath)
  return pathsToCheck.every((p) => {
    for (const denyPath of resolvedDeny) {
      if (pathInWorkingPath(p, denyPath)) {
        return false
      }
    }
    return resolvedAllow.some((allowPath) => pathInWorkingPath(p, allowPath))
  })
}

// Sandbox 配置路径在会话中稳定，记忆化其解析形式，避免每次检查写入目标都重复调用
// lstat/realpath；与 filesystem.ts 的 getResolvedWorkingDirPaths 模式一致。
const getResolvedSandboxConfigPath = memoize(getPathsForPermissionCheck)

/**
 * 检查解析后的路径是否允许执行指定类型的操作。
 *
 * @param precomputedPathsToCheck 可选的 `getPathsForPermissionCheck(resolvedPath)` 缓存结果。
 *   resolvedPath 是 realpathSync 输出的规范路径且所有 symlink 均已解析时，结果必然为
 *   `[resolvedPath]`，传入后每次内部检查可省去 5 次冗余 syscall。非规范路径（不存在的文件、
 *   UNC 路径等）仍需解析父目录 symlink，不得传入此参数。
 */
export function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  // 根据操作确定待检查的权限类型
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. 优先检查 deny 规则
  const denyRule = matchingRuleForInput(resolvedPath, context, permissionType, 'deny')
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. 对 write/create 操作检查内部可编辑路径，包括 plan 文件、scratchpad、agent memory 和
  // job 目录。此检查必须早于 checkPathSafetyForAutoEdit，因为 .zy 属于危险目录，而内部可编辑
  // 路径位于 ~/.zy/ 下；顺序与 checkWritePermissionForTool（filesystem.ts 第 1.5 步）一致。
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. 对 write/create 操作执行完整安全校验。必须早于工作目录检查，防止通过 acceptEdits
  // 模式绕过。检查 Windows 模式、Zy 配置文件及原始路径和 symlink 路径上的危险文件。
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(resolvedPath, precomputedPathsToCheck)
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. 检查路径是否位于允许的工作目录。write/create 操作需处于 acceptEdits 模式才自动允许，
  // 与 filesystem.ts 的 checkWritePermissionForTool 一致。
  const isInWorkingDir = pathInAllowedWorkingPath(resolvedPath, context, precomputedPathsToCheck)
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
    // 非 acceptEdits 模式下的 write/create 继续检查 allow 规则
  }

  // 3.5. 对 read 操作检查项目临时目录、session memory 等内部可读路径，使 agent 输出文件无需
  // 显式权限即可读取。
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. 对工作目录外路径的 write/create 操作检查 sandbox 写入 allowlist。启用 sandbox 时，
  // 用户已明确配置 /tmp/zy/ 等可写目录，将其视为额外允许写入目录，避免 redirect、touch、
  // mkdir 无谓询问权限；第 2 步已完成安全检查。工作目录内路径有意排除：sandbox allowlist
  // 始终加入 `.`（cwd，参见 sandbox-adapter.ts），否则会绕过第 3 步的 acceptEdits gate；
  // 此类路径由第 3 步处理。
  if (operationType !== 'read' && !isInWorkingDir && isPathInSandboxWriteAllowlist(resolvedPath)) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. 检查操作类型对应的 allow 规则
  const allowRule = matchingRuleForInput(resolvedPath, context, permissionType, 'allow')
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. 路径不被允许
  return { allowed: false }
}

/**
 * 通过检查基础目录校验 glob 模式，并返回 glob 展开位置基础路径的校验结果。
 */
export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  if (containsPathTraversal(cleanPath)) {
    // 对包含路径穿越的模式解析完整路径
    const absolutePath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath)
    const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absolutePath)
    const result = isPathAllowed(
      resolvedPath,
      toolPermissionContext,
      operationType,
      isCanonical ? [resolvedPath] : undefined,
    )
    return {
      allowed: result.allowed,
      resolvedPath,
      decisionReason: result.decisionReason,
    }
  }

  const basePath = getGlobBaseDirectory(cleanPath)
  const absoluteBasePath = isAbsolute(basePath) ? basePath : resolve(cwd, basePath)
  const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absoluteBasePath)
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/

/**
 * 检查解析后的路径用于删除操作（rm/rmdir）时是否危险。危险路径包括：
 * - 通配符 `*`（删除目录内全部文件）；
 * - 以 `/*` 或 `\*` 结尾的路径（如 /path/to/dir/*、C:\foo\*）；
 * - 根目录（/）；
 * - 主目录（~）；
 * - 根目录的直接子项（/usr、/tmp、/etc 等）；
 * - Windows 盘符根目录（C:\、D:\）及直接子项（C:\Windows、C:\Users）。
 */
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  // 调用方会传入两种斜杠形式，因此合并连续斜杠，避免 PowerShell 中有效的 C:\\Windows
  // 绕过盘符直接子项检查。
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, '/')

  if (forwardSlashed === '*' || forwardSlashed.endsWith('/*')) {
    return true
  }

  const normalizedPath = forwardSlashed === '/' ? forwardSlashed : forwardSlashed.replace(/\/$/, '')

  if (normalizedPath === '/') {
    return true
  }

  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) {
    return true
  }

  const normalizedHome = homedir().replace(/[\\/]+/g, '/')
  if (normalizedPath === normalizedHome) {
    return true
  }

  // 根目录直接子项：/usr、/tmp、/etc，但不包括 /usr/local
  const parentDir = dirname(normalizedPath)
  if (parentDir === '/') {
    return true
  }

  // macOS: /private/{etc,var,tmp,home} 是关键系统目录（/etc → /private/etc 等 symlink）
  const MACOS_PRIVATE_PROTECTED = new Set([
    '/private/etc',
    '/private/var',
    '/private/tmp',
    '/private/home',
  ])
  if (MACOS_PRIVATE_PROTECTED.has(normalizedPath)) {
    return true
  }

  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) {
    return true
  }

  return false
}

/**
 * 校验文件系统路径，处理波浪号展开和 glob 模式。返回是否允许以及供错误消息使用的解析路径。
 */
export function validatePath(
  path: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // 移除可能存在的首尾引号
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))

  // 安全：阻止可能泄露凭证的 UNC 路径
  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'UNC network paths require manual approval',
      },
    }
  }

  // 安全：拒绝 expandTilde 不处理的 ~user、~+、~-、~N 等波浪号变体。expandTilde 会将 ~ 和
  // ~/ 解析为 $HOME，但 ~root、~+、~- 等会保留为字面量并按相对路径解析（如
  // /cwd/~root/.ssh/id_rsa）。shell 的展开不同（~root → /var/root、~+ → $PWD、
  // ~- → $OLDPWD），形成 TOCTOU 缺口：校验 /cwd/~root/...，bash 却读取 /var/root/...
  // expandTilde 已将 ~ 和 ~/ 转成以 / 开头的绝对路径，此处剩余的只有未展开变体，不会误报。
  if (cleanPath.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'Tilde expansion variants (~user, ~+, ~-) in paths require manual approval',
      },
    }
  }

  // 安全：拒绝包含任意 shell 展开语法的路径，包括 $、% 字符或以 = 开头触发 Zsh 等号展开
  // - $VAR（Unix/Linux 环境变量，如 $HOME、$PWD）
  // - ${VAR}（花括号展开）
  // - $(cmd)（命令替换）
  // - %VAR%（Windows 环境变量，如 %TEMP%、%USERPROFILE%）
  // - $(echo $HOME) 等嵌套组合
  // - =cmd（Zsh 等号展开，例如 =rg 展开为 /usr/bin/rg）
  // 这些内容校验时保留为字面字符串，执行时却由 shell 展开，会形成 TOCTOU 漏洞
  if (cleanPath.includes('$') || cleanPath.includes('%') || cleanPath.startsWith('=')) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }

  // 安全：阻止 write/create 操作中的 glob 模式。写入 tool 不展开 glob，而是按字面路径使用；
  // 允许 glob 可能绕过安全检查。例如 /allowed/dir/*.txt 只校验 /allowed/dir，实际写入却会
  // 使用包含 * 的字面路径。
  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: cleanPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // 对 read 操作校验 glob 展开位置的基础目录
    return validateGlobPattern(cleanPath, cwd, toolPermissionContext, operationType)
  }

  // 解析路径
  const absolutePath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath)
  const { resolvedPath, isCanonical } = safeResolvePath(getFsImplementation(), absolutePath)

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}
