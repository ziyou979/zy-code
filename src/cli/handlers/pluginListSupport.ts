import { CROSS, POINTER, TICK } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { getInstallCounts } from '../../services/plugins/installCounts.js'
import { isPluginInstalled } from '../../services/plugins/installedPluginsManager.js'
import {
  createPluginId,
  loadMarketplacesWithGracefulDegradation,
} from '../../services/plugins/marketplaceHelpers.js'
import { loadKnownMarketplacesConfig } from '../../services/plugins/marketplaceManager.js'
import { loadPluginMcpServers } from '../../services/plugins/mcpPluginIntegration.js'
import { parsePluginIdentifier } from '../../services/plugins/pluginIdentifier.js'
import type { PluginSource } from '../../services/plugins/schemas.js'
import type { InstalledPluginsFileV2 } from '../../services/plugins/schemas.js'
import {
  getPluginErrorMessage,
  type LoadedPlugin,
  type PluginError,
} from '../../services/plugins/types.js'

type PluginListJsonEntry = {
  id: string
  version: string
  scope: string
  enabled: boolean
  installPath: string
  installedAt?: string
  lastUpdated?: string
  projectPath?: string
  mcpServers?: Record<string, unknown>
  errors?: string[]
}

type AvailablePluginListJsonEntry = {
  pluginId: string
  name: string
  description?: string
  marketplaceName: string
  version?: string
  source: PluginSource
  installCount?: number
}

type PluginListRenderData = {
  enabledPlugins: ReadonlyMap<string, unknown>
  inlineLoadErrors: PluginError[]
  inlinePlugins: LoadedPlugin[]
  installedData: InstalledPluginsFileV2
  loadErrors: PluginError[]
  pluginIds: string[]
}

function getPluginErrors(loadErrors: PluginError[], pluginId: string): PluginError[] {
  const pluginName = parsePluginIdentifier(pluginId).name
  return loadErrors.filter(
    (error) => error.source === pluginId || ('plugin' in error && error.plugin === pluginName),
  )
}

function getInlinePluginErrors(
  inlineLoadErrors: PluginError[],
  plugin: LoadedPlugin,
): PluginError[] {
  return inlineLoadErrors.filter(
    (error) =>
      error.source === plugin.source || ('plugin' in error && error.plugin === plugin.name),
  )
}

export async function buildPluginListJsonEntries(params: {
  allLoadedPlugins: LoadedPlugin[]
  enabledPlugins: ReadonlyMap<string, unknown>
  inlineLoadErrors: PluginError[]
  inlinePlugins: LoadedPlugin[]
  installedData: InstalledPluginsFileV2
  loadErrors: PluginError[]
  pluginIds: string[]
}): Promise<PluginListJsonEntry[]> {
  const loadedPluginMap = new Map(params.allLoadedPlugins.map((plugin) => [plugin.source, plugin]))
  const plugins: PluginListJsonEntry[] = []

  for (const pluginId of params.pluginIds.sort()) {
    const installations = params.installedData.plugins[pluginId]
    if (!installations || installations.length === 0) {
      continue
    }

    const pluginErrors = getPluginErrors(params.loadErrors, pluginId).map(getPluginErrorMessage)

    for (const installation of installations) {
      const loadedPlugin = loadedPluginMap.get(pluginId)
      let mcpServers: Record<string, unknown> | undefined

      if (loadedPlugin) {
        const servers = loadedPlugin.mcpServers || (await loadPluginMcpServers(loadedPlugin))
        if (servers && Object.keys(servers).length > 0) {
          mcpServers = servers
        }
      }

      plugins.push({
        id: pluginId,
        version: installation.version || 'unknown',
        scope: installation.scope,
        enabled: params.enabledPlugins.has(pluginId),
        installPath: installation.installPath,
        installedAt: installation.installedAt,
        lastUpdated: installation.lastUpdated,
        projectPath: installation.projectPath,
        mcpServers,
        errors: pluginErrors.length > 0 ? pluginErrors : undefined,
      })
    }
  }

  for (const plugin of params.inlinePlugins) {
    const servers = plugin.mcpServers || (await loadPluginMcpServers(plugin))
    const pluginErrors = getInlinePluginErrors(params.inlineLoadErrors, plugin).map(
      getPluginErrorMessage,
    )

    plugins.push({
      id: plugin.source,
      version: plugin.manifest.version ?? 'unknown',
      scope: 'session',
      enabled: plugin.enabled !== false,
      installPath: plugin.path,
      mcpServers: servers && Object.keys(servers).length > 0 ? servers : undefined,
      errors: pluginErrors.length > 0 ? pluginErrors : undefined,
    })
  }

  for (const error of params.inlineLoadErrors.filter((item) => item.source.startsWith('inline['))) {
    plugins.push({
      id: error.source,
      version: 'unknown',
      scope: 'session',
      enabled: false,
      installPath: 'path' in error ? error.path : '',
      errors: [getPluginErrorMessage(error)],
    })
  }

  return plugins
}

export async function buildAvailablePluginListEntries(): Promise<AvailablePluginListJsonEntry[]> {
  const available: AvailablePluginListJsonEntry[] = []

  try {
    const [config, installCounts] = await Promise.all([
      loadKnownMarketplacesConfig(),
      getInstallCounts(),
    ])
    const { marketplaces } = await loadMarketplacesWithGracefulDegradation(config)

    for (const { name: marketplaceName, data: marketplace } of marketplaces) {
      if (!marketplace) {
        continue
      }

      for (const entry of marketplace.plugins) {
        const pluginId = createPluginId(entry.name, marketplaceName)
        if (isPluginInstalled(pluginId)) {
          continue
        }

        available.push({
          pluginId,
          name: entry.name,
          description: entry.description,
          marketplaceName,
          version: entry.version,
          source: entry.source,
          installCount: installCounts?.get(pluginId),
        })
      }
    }
  } catch {
    // 静默忽略 marketplace 加载错误
  }

  return available
}

export function printPluginListReport(params: PluginListRenderData): void {
  if (params.pluginIds.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${tSync('plugins.list.installedHeader')}\n`)
  }

  for (const pluginId of params.pluginIds.sort()) {
    const installations = params.installedData.plugins[pluginId]
    if (!installations || installations.length === 0) {
      continue
    }

    const pluginErrors = getPluginErrors(params.loadErrors, pluginId)

    for (const installation of installations) {
      const status =
        pluginErrors.length > 0
          ? `${CROSS} ${tSync('plugins.list.statusLoadFailed')}`
          : params.enabledPlugins.has(pluginId)
            ? `${TICK} ${tSync('plugins.list.statusEnabled')}`
            : `${CROSS} ${tSync('plugins.list.statusDisabled')}`

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${POINTER} ${pluginId}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(
        `    ${tSync('plugins.list.version', { version: installation.version || 'unknown' })}`,
      )
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    ${tSync('plugins.list.scope', { scope: installation.scope })}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    ${tSync('plugins.list.statusLabel', { status })}`)
      for (const error of pluginErrors) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          `    ${tSync('plugins.list.errorLabel', { error: getPluginErrorMessage(error) })}`,
        )
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    }
  }

  if (params.inlinePlugins.length === 0 && params.inlineLoadErrors.length === 0) {
    return
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`${tSync('plugins.list.sessionOnly')}\n`)

  for (const plugin of params.inlinePlugins) {
    const pluginErrors = getInlinePluginErrors(params.inlineLoadErrors, plugin)
    const status =
      pluginErrors.length > 0
        ? `${CROSS} ${tSync('plugins.list.statusLoadedWithErrors')}`
        : `${TICK} ${tSync('plugins.list.statusLoaded')}`

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  ${POINTER} ${plugin.source}`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `    ${tSync('plugins.list.version', { version: plugin.manifest.version ?? 'unknown' })}`,
    )
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`    ${tSync('plugins.list.pathLabel', { path: plugin.path })}`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`    ${tSync('plugins.list.statusLabel', { status })}`)
    for (const error of pluginErrors) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(
        `    ${tSync('plugins.list.errorLabel', { error: getPluginErrorMessage(error) })}`,
      )
    }
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }

  for (const error of params.inlineLoadErrors.filter((item) => item.source.startsWith('inline['))) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  ${POINTER} ${error.source}: ${CROSS} ${getPluginErrorMessage(error)}\n`)
  }
}
