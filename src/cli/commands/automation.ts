import { feature } from 'bun:bundle'
import type { Command } from '@commander-js/extra-typings'
import { getAutoModeEnabledStateIfCached } from '../../services/permissions/permissionSetup.js'

/**
 * 注册自动化/桥接相关命令：
 * - agents（列出已配置 agents）
 * - auto-mode <defaults|config|critique>（TRANSCRIPT_CLASSIFIER）
 * - remote-control / rc（BRIDGE_MODE，hidden 占位）
 * - assistant [sessionId]（KAIROS，stub）
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerAutomationCommands(program: Command<any, any, any>): void {
  // Agents command - list configured agents
  program
    .command('agents')
    .description('List configured agents')
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    .action(async () => {
      const { agentsHandler } = await import('../handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  // Skip when zy_auto_mode_config.enabled === 'disabled' (circuit breaker).
  // Reads from disk cache — GrowthBook isn't initialized at registration time.
  if (getAutoModeEnabledStateIfCached() !== 'disabled') {
    const autoModeCmd = program
      .command('auto-mode')
      .description('Inspect auto mode classifier configuration')
    autoModeCmd
      .command('defaults')
      .description('Print the default auto mode environment, allow, and deny rules as JSON')
      .action(async () => {
        const { autoModeDefaultsHandler } = await import('../handlers/autoMode.js')
        autoModeDefaultsHandler()
        process.exit(0)
      })
    autoModeCmd
      .command('config')
      .description(
        'Print the effective auto mode config as JSON: your settings where set, defaults otherwise',
      )
      .action(async () => {
        const { autoModeConfigHandler } = await import('../handlers/autoMode.js')
        autoModeConfigHandler()
        process.exit(0)
      })
    autoModeCmd
      .command('critique')
      .description('Get AI feedback on your custom auto mode rules')
      .option('--model <model>', 'Override which model is used')
      .action(async (options) => {
        const { autoModeCritiqueHandler } = await import('../handlers/autoMode.js')
        await autoModeCritiqueHandler(options)
        process.exit()
      })
  }

  // Remote Control command — connect local environment to zy.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw → getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control', {
        hidden: true,
      })
      .alias('rc')
      .description('Connect your local environment for remote-control sessions via zy.ai/code')
      .action(async () => {
        // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
        // If somehow reached, delegate to bridgeMain.
        const { bridgeMain } = await import('../../bridge/bridgeMain.js')
        await bridgeMain(process.argv.slice(3))
      })
  }

  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // Argv rewriting above should have consumed `assistant [id]`
        // before commander runs. Reaching here means a root flag came first
        // (e.g. `--debug assistant`) and the position-0 predicate
        // didn't match. Print usage like the ssh stub does.
        process.stderr.write(
          'Usage: zy assistant [sessionId]\n\n' +
            'Attach the REPL as a viewer client to a running bridge session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        )
        process.exit(1)
      })
  }
}
