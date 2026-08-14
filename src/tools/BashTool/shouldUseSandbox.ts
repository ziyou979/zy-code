import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { SandboxManager } from '../../services/sandbox/sandboxAdapter.js'
import { splitCommand_DEPRECATED } from '../../shell-eval/bash/commands.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import {
  parsePermissionRule,
  matchWildcardPattern,
} from '../../services/permissions/shellRuleMatching.js'
import { BINARY_HIJACK_VARS, stripAllLeadingEnvVars, stripSafeWrappers } from './bashPermissions.js'

const bashPermissionRule = parsePermissionRule

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// 注意：excludedCommands 是面向用户的便利功能，不是安全边界。
// 能够绕过 excludedCommands 不属于安全漏洞；真正的安全控制是会提示用户的 sandbox permission 系统。
function containsExcludedCommand(command: string): boolean {
  // 检查动态配置中禁用的命令和子串（仅 ants）
  if (isInternalBuild()) {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('zy_sandbox_disabled_commands', { commands: [], substrings: [] })

    // 检查命令是否包含任一禁用子串
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // 检查命令是否以任一禁用命令开头
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // 无法解析命令（如 bash 语法错误）时，视为未排除，交由其他校验处理。
      // 这可避免渲染 Tool 调用消息时崩溃。
    }
  }

  // 检查 settings 中用户配置的排除命令
  const settings = getInitialSettings()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // 将复合命令（如 "docker ps && curl evil.com"）拆分为独立子命令，
  // 并逐一与排除模式匹配。这可防止复合命令仅因首个子命令匹配排除模式就逃离 sandbox。
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // 同时尝试移除 env var 前缀和 wrapper 命令后再匹配，使
    // `FOO=bar bazel ...` 和 `timeout 30 bazel ...` 可匹配 `bazel:*`。这不是安全边界
    //（参见顶部注释）；上方 && 拆分已能使 `export FOO=bar && bazel ...` 匹配。
    // BINARY_HIJACK_VARS 仅作为启发式规则保留。
    //
    // 反复应用两种移除操作，直到不再产生新候选（不动点），
    // 与 filterRulesByContentsMatchingInput 的方法一致。这可处理
    // `timeout 300 FOO=bar bazel run` 这类交错模式，单次组合无法正确处理。
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(`${rule.prefix} `)) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // 已显式覆盖且 policy 允许非 sandbox 命令时，不使用 sandbox
  if (input.dangerouslyDisableSandbox && SandboxManager.areUnsandboxedCommandsAllowed()) {
    return false
  }

  if (!input.command) {
    return false
  }

  // 命令包含用户配置的排除命令时，不使用 sandbox
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
