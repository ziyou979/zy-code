import type { z } from 'zod/v4'
import { tSync } from '../../i18n/index.js'
import {
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
} from '../../shell-eval/bash/commands.js'
import {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from '../../shell-eval/bash/parsedCommand.js'
import { type Node, PARSE_ABORTED } from '../../shell-eval/bash/parser.js'
import type { PermissionResult } from 'src/types/permissions.js'
import type { PermissionUpdate } from 'src/types/permissions.js'
import { createPermissionRequestMessage } from '../../services/permissions/permissionRuleQueries.js'
import { BashTool } from './BashTool.js'
import { bashCommandIsSafeAsync_DEPRECATED } from './bashSecurity.js'

export type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}

async function segmentedCommandPermissionResult(
  input: z.infer<typeof BashTool.inputSchema>,
  segments: string[],
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
): Promise<PermissionResult> {
  // 检查所有片段中是否存在多个 cd 命令
  const cdCommands = segments.filter((segment) => {
    const trimmed = segment.trim()
    return checkers.isNormalizedCdCommand(trimmed)
  })
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason: tSync('bash.permission.multipleCd'),
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // 安全：检查跨 pipe 片段的 cd+git，防止绕过 bare repo fsmonitor。
  // cd 和 git 位于不同 pipe 片段时（如 "cd sub && echo | git status"），
  // 各片段会独立检查，均不会触发 bashPermissions.ts 中的 cd+git 检查。
  // 因此必须在此检测跨片段模式。每个 pipe 片段本身也可能是复合命令，
  // 所以检查前要将各片段再拆分为子命令。
  {
    let hasCd = false
    let hasGit = false
    for (const segment of segments) {
      const subcommands = splitCommand_DEPRECATED(segment)
      for (const sub of subcommands) {
        const trimmed = sub.trim()
        if (checkers.isNormalizedCdCommand(trimmed)) {
          hasCd = true
        }
        if (checkers.isNormalizedGitCommand(trimmed)) {
          hasGit = true
        }
      }
    }
    if (hasCd && hasGit) {
      const decisionReason = {
        type: 'other' as const,
        reason: tSync('bash.permission.cdAndGit'),
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  const segmentResults = new Map<string, PermissionResult>()

  // 通过完整 permission 系统检查每个片段
  for (const segment of segments) {
    const trimmedSegment = segment.trim()
    if (!trimmedSegment) {
      continue // 跳过空片段
    }

    const segmentResult = await bashToolHasPermissionFn({
      ...input,
      command: trimmedSegment,
    })
    segmentResults.set(trimmedSegment, segmentResult)
  }

  // 评估所有片段后，检查是否有任一片段被拒绝
  const deniedSegment = Array.from(segmentResults.entries()).find(
    ([, result]) => result.behavior === 'deny',
  )

  if (deniedSegment) {
    const [segmentCommand, segmentResult] = deniedSegment
    return {
      behavior: 'deny',
      message:
        segmentResult.behavior === 'deny'
          ? segmentResult.message
          : `Permission denied for: ${segmentCommand}`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  const allAllowed = Array.from(segmentResults.values()).every(
    (result) => result.behavior === 'allow',
  )

  if (allAllowed) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // 汇总需要批准的片段所提供的 suggestion
  const suggestions: PermissionUpdate[] = []
  for (const [, result] of segmentResults) {
    if (result.behavior !== 'allow' && 'suggestions' in result && result.suggestions) {
      suggestions.push(...result.suggestions)
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: segmentResults,
  }

  return {
    behavior: 'ask',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  }
}

/**
 * 构建命令片段，移除输出重定向，避免 permission 检查将文件名当作命令。
 * 使用 ParsedCommand 保留原始引号。
 */
async function buildSegmentWithoutRedirections(segmentCommand: string): Promise<string> {
  // 快速路径：不存在重定向 operator 时跳过解析
  if (!segmentCommand.includes('>')) {
    return segmentCommand
  }

  // 使用 ParsedCommand 在保留引号的同时移除重定向
  const parsed = await ParsedCommand.parse(segmentCommand)
  return parsed?.withoutOutputRedirections() ?? segmentCommand
}

/**
 * Wrapper that resolves an IParsedCommand (from a pre-parsed AST root if
 * available, else via ParsedCommand.parse) and delegates to
 * bashToolCheckCommandOperatorPermissions.
 */
export async function checkCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | null | typeof PARSE_ABORTED,
): Promise<PermissionResult> {
  const parsed =
    astRoot && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  if (!parsed) {
    return { behavior: 'passthrough', message: tSync('bash.permission.parseFailed') }
  }
  return bashToolCheckCommandOperatorPermissions(input, bashToolHasPermissionFn, checkers, parsed)
}

/**
 * 检查命令是否包含需要超出简单子命令检查的特殊 operator。
 */
async function bashToolCheckCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  parsed: IParsedCommand,
): Promise<PermissionResult> {
  // 1. 检查不安全的复合命令（subshell、命令组）。
  const tsAnalysis = parsed.getTreeSitterAnalysis()
  const isUnsafeCompound = tsAnalysis
    ? tsAnalysis.compoundStructure.hasSubshell || tsAnalysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (isUnsafeCompound) {
    // This command contains an operator like `>` that we don't support as a subcommand separator
    // Check if bashCommandIsSafe_DEPRECATED has a more specific message
    const safetyResult = await bashCommandIsSafeAsync_DEPRECATED(input.command)

    const decisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : tSync('bash.permission.shellOperators'),
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
      // This is an unsafe compound command, so we don't want to suggest rules since we wont be able to allow it
    }
  }

  // 2. 使用 ParsedCommand 检查 pipe 命令（保留引号）
  const pipeSegments = parsed.getPipeSegments()

  // 没有 pipe（单片段）时交由常规流程处理
  if (pipeSegments.length <= 1) {
    return {
      behavior: 'passthrough',
      message: tSync('bash.permission.noPipes'),
    }
  }

  // 保留引号的同时移除每个片段的输出重定向
  const segments = await Promise.all(
    pipeSegments.map((segment) => buildSegmentWithoutRedirections(segment)),
  )

  // 按分段命令处理
  return segmentedCommandPermissionResult(input, segments, bashToolHasPermissionFn, checkers)
}
