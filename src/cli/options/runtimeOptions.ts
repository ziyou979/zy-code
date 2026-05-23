import { feature } from 'bun:bundle'
import { Command, Option } from '@commander-js/extra-typings'
import { canUserConfigureAdvisor } from '../../utils/advisor.js'
import { isInternalBuild } from '../../utils/envUtils.js'

/**
 * 运行时 / feature-gate 决定是否注册的根命令选项。
 *
 * 与 cli/options/* 中其它"静态"组不同，这里的 .option() 是否生效依赖
 * `canUserConfigureAdvisor()` / `isInternalBuild()` / `feature(X)` 等只能
 * 在运行时计算的判定，所以独立成一组、在 root .action() 之后调用。
 *
 * 包含的选项分布：
 * - worktree：--worktree、--tmux
 * - 顾问（条件）：--advisor
 * - INNER-ONLY：--delegate-permissions、--dangerously-skip-permissions-with-classifiers、--afk、--tasks、--agent-teams
 * - feature gate 系：--enable-auto-mode、--proactive、--messaging-socket-path、--brief、--assistant、--channels、--dangerously-load-development-channels
 * - 队友身份（hidden）：--agent-id、--agent-name、--team-name、--agent-color、--plan-mode-required、--parent-session-id、--teammate-mode、--agent-type
 * - SDK / teleport（hidden）：--sdk-url、--teleport、--remote
 * - BRIDGE_MODE 系：--remote-control、--rc
 * - HARD_FAIL：--hard-fail
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function applyRuntimeOptions(program: Command<any, any, any>): void {
  // worktree 标志
  program.option(
    '-w, --worktree [name]',
    'Create a new git worktree for this session (optionally specify a name)',
  )
  program.option(
    '--tmux',
    'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.',
  )
  if (canUserConfigureAdvisor()) {
    program.addOption(
      new Option(
        '--advisor <model>',
        'Enable the server-side advisor tool with the specified model (alias or full ID).',
      ).hideHelp(),
    )
  }
  if (isInternalBuild()) {
    program.addOption(
      new Option(
        '--delegate-permissions',
        '[INNER-ONLY] Alias for --permission-mode auto.',
      ).implies({
        permissionMode: 'auto',
      }),
    )
    program.addOption(
      new Option(
        '--dangerously-skip-permissions-with-classifiers',
        '[INNER-ONLY] Deprecated alias for --permission-mode auto.',
      )
        .hideHelp()
        .implies({
          permissionMode: 'auto',
        }),
    )
    program.addOption(
      new Option('--afk', '[INNER-ONLY] Deprecated alias for --permission-mode auto.')
        .hideHelp()
        .implies({
          permissionMode: 'auto',
        }),
    )
    program.addOption(
      new Option(
        '--tasks [id]',
        '[INNER-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").',
      )
        .argParser(String)
        .hideHelp(),
    )
    program.option(
      '--agent-teams',
      '[INNER-ONLY] Force ZY to use multi-agent mode for solving problems',
      () => true,
    )
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp())
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'))
  }
  if (feature('UDS_INBOX')) {
    program.addOption(
      new Option(
        '--messaging-socket-path <path>',
        'Unix domain socket path for the UDS messaging server (defaults to a tmp path)',
      ),
    )
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(
      new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'),
    )
  }
  if (feature('KAIROS')) {
    program.addOption(
      new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp(),
    )
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(
      new Option(
        '--channels <servers...>',
        'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.',
      ).hideHelp(),
    )
    program.addOption(
      new Option(
        '--dangerously-load-development-channels <servers...>',
        'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.',
      ).hideHelp(),
    )
  }

  // 队友身份选项（由领导者在生成 tmux 队友时设置）
  // 这些替换了 ZY_CODE_* 环境变量
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp())
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp())
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp())
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp())
  program.addOption(
    new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp(),
  )
  program.addOption(
    new Option(
      '--parent-session-id <id>',
      'Parent session ID for analytics correlation',
    ).hideHelp(),
  )
  program.addOption(
    new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"')
      .choices(['auto', 'tmux', 'in-process'])
      .hideHelp(),
  )
  program.addOption(
    new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp(),
  )

  // 为所有构建启用 SDK URL 但从帮助中隐藏
  program.addOption(
    new Option(
      '--sdk-url <url>',
      'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)',
    ).hideHelp(),
  )

  // 为所有构建启用 teleport/remote 标志，但在 GA 之前保持未文档化
  program.addOption(
    new Option(
      '--teleport [session]',
      'Resume a teleport session, optionally specify session ID',
    ).hideHelp(),
  )
  program.addOption(
    new Option(
      '--remote [description]',
      'Create a remote session with the given description',
    ).hideHelp(),
  )
  if (feature('BRIDGE_MODE')) {
    program.addOption(
      new Option(
        '--remote-control [name]',
        'Start an interactive session with Remote Control enabled (optionally named)',
      )
        .argParser((value) => value || true)
        .hideHelp(),
    )
    program.addOption(
      new Option('--rc [name]', 'Alias for --remote-control')
        .argParser((value) => value || true)
        .hideHelp(),
    )
  }
  if (feature('HARD_FAIL')) {
    program.addOption(
      new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp(),
    )
  }
}
