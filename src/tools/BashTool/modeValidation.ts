import type { z } from 'zod/v4'
import { splitCommand_DEPRECATED } from '../../shell-eval/bash/commands.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import type { PermissionResult } from 'src/types/permissions.js'
import type { BashTool } from './BashTool.js'

const ACCEPT_EDITS_ALLOWED_COMMANDS = ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'] as const

type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]

function isFilesystemCommand(command: string): command is FilesystemCommand {
  return ACCEPT_EDITS_ALLOWED_COMMANDS.includes(command as FilesystemCommand)
}

function validateCommandForMode(
  cmd: string,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCmd = cmd.trim()
  const [baseCmd] = trimmedCmd.split(/\s+/)

  if (!baseCmd) {
    return {
      behavior: 'passthrough',
      message: 'Base command not found',
    }
  }

  // Accept Edits 模式下自动允许文件系统操作
  if (toolPermissionContext.mode === 'acceptEdits' && isFilesystemCommand(baseCmd)) {
    return {
      behavior: 'allow',
      updatedInput: { command: cmd },
      decisionReason: {
        type: 'mode',
        mode: 'acceptEdits',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: `No mode-specific handling for '${baseCmd}' in ${toolPermissionContext.mode} mode`,
  }
}

/**
 * 检查是否应根据当前 permission 模式对命令采取不同处理。
 *
 * 这是基于模式的 permission 逻辑主入口。
 * 当前处理 Accept Edits 模式下的文件系统命令，设计上可扩展到其他模式。
 *
 * @param input - The bash command input
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'ask' if the command needs approval in current mode
 * - 'passthrough' if no mode-specific handling applies
 */
export function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // bypass 模式由其他流程处理，此处跳过
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'passthrough',
      message: 'Bypass mode is handled in main permission flow',
    }
  }

  // dontAsk 模式由主 permission 流程处理，此处跳过
  if (toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'passthrough',
      message: 'DontAsk mode is handled in main permission flow',
    }
  }

  const commands = splitCommand_DEPRECATED(input.command)

  // 检查每个子命令
  for (const cmd of commands) {
    const result = validateCommandForMode(cmd, toolPermissionContext)

    // 任一命令触发模式专属行为时，返回该结果
    if (result.behavior !== 'passthrough') {
      return result
    }
  }

  // 无需模式专属处理
  return {
    behavior: 'passthrough',
    message: 'No mode-specific validation required',
  }
}

export function getAutoAllowedCommands(mode: ToolPermissionContext['mode']): readonly string[] {
  return mode === 'acceptEdits' ? ACCEPT_EDITS_ALLOWED_COMMANDS : []
}
