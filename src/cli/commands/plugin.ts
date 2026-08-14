import { Command, Option } from '@commander-js/extra-typings'
import {
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'
import { createSortedHelpConfig } from '../options/sortedHelp.js'
/**
 * 注册插件相关命令组：
 * - zy plugin validate / list / install / uninstall / enable / disable / update
 * - zy plugin marketplace add / list / remove / update
 *
 * 所有子命令共享 `--cowork` 隐藏标志，用于切换到 cowork_plugins 目录。
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerPluginCommands(program: Command<any, any, any>): void {
  // 在所有插件/市场子命令上的隐藏标志，以 targeting cowork_plugins。
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp()

  // Plugin 校验命令
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage ZY Code plugins')
    .configureHelp(createSortedHelpConfig())
  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(
      async (
        manifestPath: string,
        options: {
          cowork?: boolean
        },
      ) => {
        const { pluginValidateHandler } = await import('../handlers/plugins.js')
        await pluginValidateHandler(manifestPath, options)
      },
    )

  // Plugin 列表命令
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option('--available', 'Include available plugins from marketplaces (requires --json)')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; available?: boolean; cowork?: boolean }) => {
      const { pluginListHandler } = await import('../handlers/plugins.js')
      await pluginListHandler(options)
    })

  // Marketplace 子命令
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage ZY Code marketplaces')
    .configureHelp(createSortedHelpConfig())
  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .zy-plugin plugins',
    )
    .option(
      '--scope <scope>',
      'Where to declare the marketplace: user (default), project, or local',
    )
    .action(
      async (
        source: string,
        options: {
          cowork?: boolean
          sparse?: string[]
          scope?: string
        },
      ) => {
        const { marketplaceAddHandler } = await import('../handlers/plugins.js')
        await marketplaceAddHandler(source, options)
      },
    )
  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import('../handlers/plugins.js')
      await marketplaceListHandler(options)
    })
  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(
      async (
        name: string,
        options: {
          cowork?: boolean
        },
      ) => {
        const { marketplaceRemoveHandler } = await import('../handlers/plugins.js')
        await marketplaceRemoveHandler(name, options)
      },
    )
  marketplaceCmd
    .command('update [name]')
    .description('Update marketplace(s) from their source - updates all if no name specified')
    .addOption(coworkOption())
    .action(
      async (
        name: string | undefined,
        options: {
          cowork?: boolean
        },
      ) => {
        const { marketplaceUpdateHandler } = await import('../handlers/plugins.js')
        await marketplaceUpdateHandler(name, options)
      },
    )

  // Plugin 安装命令
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description(
      'Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)',
    )
    .option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user')
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginInstallHandler } = await import('../handlers/plugins.js')
        await pluginInstallHandler(plugin, options)
      },
    )

  // Plugin 卸载命令
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user')
    .option(
      '--keep-data',
      "Preserve the plugin's persistent data directory (~/.zy/plugins/data/{id}/)",
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
          keepData?: boolean
        },
      ) => {
        const { pluginUninstallHandler } = await import('../handlers/plugins.js')
        await pluginUninstallHandler(plugin, options)
      },
    )

  // Plugin 启用命令
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginEnableHandler } = await import('../handlers/plugins.js')
        await pluginEnableHandler(plugin, options)
      },
    )

  // Plugin 禁用命令
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string | undefined,
        options: {
          scope?: string
          cowork?: boolean
          all?: boolean
        },
      ) => {
        const { pluginDisableHandler } = await import('../handlers/plugins.js')
        await pluginDisableHandler(plugin, options)
      },
    )

  // Plugin 更新命令
  pluginCmd
    .command('update <plugin>')
    .description('Update a plugin to the latest version (restart required to apply)')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginUpdateHandler } = await import('../handlers/plugins.js')
        await pluginUpdateHandler(plugin, options)
      },
    )
}
