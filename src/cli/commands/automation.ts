import type { Command } from '@commander-js/extra-typings'
import { getAutoModeEnabledStateIfCached } from '../../services/permissions/autoModePolicy.js'

/**
 * 注册自动化相关命令：
 * - agents（列出已配置 agents）
 * - auto-mode <defaults|config|critique>（TRANSCRIPT_CLASSIFIER）
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
}
