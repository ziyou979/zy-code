/**
 * Git/cd 命令检测工具函数。
 *
 * 从 bashPermissions.ts 提取。用于安全地检测经过 shell wrapper 规范化后
 * 的 git 和 cd 命令，防止绕过安全检查。
 */
import { tryParseShellCommand } from '../../shell-eval/bash/shellQuote.js'
import { splitCommand_DEPRECATED } from '../../shell-eval/bash/commands.js'
import { stripSafeWrappers } from './bashPermissions.js'

const splitCommand = splitCommand_DEPRECATED

/**
 * 检查命令是否为 git 命令（可安全匹配规范化后）。
 * 处理 env 前缀、shell 引号等绕过方式。
 */
export function isNormalizedGitCommand(command: string): boolean {
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    if (parsed.tokens[0] === 'git') {
      return true
    }
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * 检查命令是否为 cd/pushd/popd 命令（可安全匹配规范化后）。
 * 处理 env 前缀、shell 引号等绕过方式。
 */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * 检查复合命令是否包含任何 cd 命令。
 */
export function commandHasAnyCd(command: string): boolean {
  return splitCommand(command).some((subcmd) => isNormalizedCdCommand(subcmd.trim()))
}
