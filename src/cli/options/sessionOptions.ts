import { Command, Option } from '@commander-js/extra-typings'

/**
 * 会话恢复/继续/分叉 + 深链接元数据 + system prompt 注入：
 * -c/--continue、-r/--resume、--fork-session、--prefill（隐藏）、--no-session-persistence、
 * --resume-session-at（隐藏）、--rewind-files（隐藏）、--from-pr、--deep-link-*（隐藏）、
 * --system-prompt[-file]、--append-system-prompt[-file]。
 */
// biome-ignore lint/suspicious/noExplicitAny: 链式扩展跨函数边界不可保留
export function applySessionOptions(cmd: Command<any, any>): Command<any, any> {
  return cmd
    .option(
      '-c, --continue',
      'Continue the most recent conversation in the current directory',
      () => true,
    )
    .option(
      '-r, --resume [value]',
      'Resume a conversation by session ID, or open interactive picker with optional search term',
      (value) => value || true,
    )
    .option(
      '--fork-session',
      'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)',
      () => true,
    )
    .addOption(
      new Option(
        '--prefill <text>',
        'Pre-fill the prompt input with text without submitting it',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-origin',
        'Signal that this session was launched from a deep link',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-repo <slug>',
        'Repo slug the deep link ?repo= parameter resolved to the current cwd',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-last-fetch <ms>',
        'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline',
      )
        .argParser((v) => {
          const n = Number(v)
          return Number.isFinite(n) ? n : undefined
        })
        .hideHelp(),
    )
    .option(
      '--from-pr [value]',
      'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term',
      (value) => value || true,
    )
    .option(
      '--no-session-persistence',
      'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)',
    )
    .addOption(
      new Option(
        '--resume-session-at <message id>',
        'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--rewind-files <user-message-id>',
        'Restore files to state at the specified user message and exit (requires --resume)',
      ).hideHelp(),
    )
    .addOption(
      new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(
        String,
      ),
    )
    .addOption(
      new Option('--system-prompt-file <file>', 'Read system prompt from a file')
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--append-system-prompt <prompt>',
        'Append a system prompt to the default system prompt',
      ).argParser(String),
    )
    .addOption(
      new Option(
        '--append-system-prompt-file <file>',
        'Read system prompt from a file and append to the default system prompt',
      )
        .argParser(String)
        .hideHelp(),
    )
}
