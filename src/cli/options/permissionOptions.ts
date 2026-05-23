import { Command, Option } from '@commander-js/extra-typings'
import { PERMISSION_MODES } from '../../utils/permissions/PermissionMode.js'

/**
 * 权限相关选项：--dangerously-skip-permissions、--allow-dangerously-skip-permissions、
 * --permission-prompt-tool（隐藏）、--permission-mode。
 */
// biome-ignore lint/suspicious/noExplicitAny: 链式扩展跨函数边界不可保留
export function applyPermissionOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .option(
      '--dangerously-skip-permissions',
      'Bypass all permission checks. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .option(
      '--allow-dangerously-skip-permissions',
      'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .addOption(
      new Option(
        '--permission-prompt-tool <tool>',
        'MCP tool to use for permission prompts (only works with --print)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option('--permission-mode <mode>', 'Permission mode to use for the session')
        .argParser(String)
        .choices(PERMISSION_MODES),
    )
}
