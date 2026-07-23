/**
 * Auto 编辑模式路径安全检查。
 *
 * 从 filesystem.ts 提取。判断文件路径在 acceptEdits 模式下
 * 是否可安全自动编辑，检测危险文件、危险目录、可疑 Windows 路径模式。
 */
import { join, sep } from 'node:path'
import { containsVulnerableUncPath } from 'src/shell-eval/shared/readOnlyCommandValidation.js'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { getPlatform } from '../shell/platform.js'
import { getPathsForPermissionCheck } from '../../services/infra/fsOperations.js'
import { expandPath } from '../../utils/path.js'
import { isZySettingsPath } from './filesystemPolicy.js'
import { normalizeCaseForComparison, pathInWorkingPath } from './internalPaths.js'

// ─── 危险文件/目录常量 ──────────────────────────

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

// ─── 内部帮助函数 ──────────────────────────────

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

function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      if (dir === '.zy') {
        const nextSegment = pathSegments[i + 1]
        if (nextSegment && normalizeCaseForComparison(nextSegment) === 'worktrees') {
          break
        }
      }

      return true
    }
  }

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

export function hasSuspiciousWindowsPathPattern(path: string): boolean {
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  if (/~\d/.test(path)) {
    return true
  }

  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  if (/[.\s]+$/.test(path)) {
    return true
  }

  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

// ─── 导出函数 ──────────────────────────────────

/**
 * 检查路径对 auto 编辑（acceptEdits 模式）是否安全。
 * 返回路径不安全的原因信息，如果所有检查通过则返回 null。
 *
 * 此函数执行全面的安全检查，包括：
 * - 可疑 Windows 路径模式（NTFS 流、8.3 名称、长路径前缀等）
 * - Zy 配置文件（.zy/settings.json、.zy/commands/、.zy/agents/）
 * - MCP CLI 状态文件（由 ZY Code 内部管理）
 * - 危险文件（.bashrc、.gitconfig、.git/、.vscode/、.idea/ 等）
 * - UNC 路径
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
  const pathsToCheck = precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedWriteSuspiciousWindowsPath', { path }),
        classifierApprovable: false,
      }
    }
  }

  for (const pathToCheck of pathsToCheck) {
    if (isZyConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedWritePathNotGranted', { path }),
        classifierApprovable: true,
      }
    }
  }

  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: tSync('permission.requestedEditSensitiveFile', { path }),
        classifierApprovable: true,
      }
    }
  }

  return { safe: true }
}
