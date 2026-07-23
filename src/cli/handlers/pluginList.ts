import { CROSS, POINTER, TICK } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { getPluginErrorMessage } from '../../services/plugins/types.js'
import {
  type PluginListRenderData,
  getPluginErrors,
  getInlinePluginErrors,
} from './pluginListModel.js'

/**
 * 打印插件列表报告到控制台。
 * 纯展示职责，不做数据加载。
 */
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
