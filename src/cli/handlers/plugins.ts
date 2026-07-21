/**
 * 插件和 marketplace 子命令处理器 — 从 main.tsx 提取以便懒加载。
 * 仅在运行 `zy plugin *` 或 `zy plugin marketplace *` 时动态导入。
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { basename, dirname } from 'node:path'
import { setUseCoworkPlugins } from 'src/bootstrap/runtime/runtimeContext.js'
import { CROSS, POINTER, TICK, WARNING } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import {
  disableAllPlugins,
  disablePlugin,
  enablePlugin,
  installPlugin,
  uninstallPlugin,
  updatePluginCli,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { clearAllCaches } from '../../services/plugins/cacheUtils.js'
import { loadInstalledPlugins } from '../../services/plugins/installedPluginsManager.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
  removeMarketplaceSource,
  saveMarketplaceToSettings,
} from '../../services/plugins/marketplaceManager.js'
import { parseMarketplaceInput } from '../../services/plugins/parseMarketplaceInput.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../services/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../services/plugins/pluginLoader.js'
import {
  type ValidationResult,
  validateManifest,
  validatePluginContents,
} from '../../services/plugins/validatePlugin.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import {
  buildAvailablePluginListEntries,
  buildPluginListJsonEntries,
  printPluginListReport,
} from './pluginListSupport.js'
import { cliError, cliOk } from '../exit.js'

// 重新导出，供 main.tsx 在选项定义中引用
export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

/**
 * 处理 marketplace 命令错误的辅助函数。
 */
export function handleMarketplaceError(error: unknown, action: string): never {
  logError(error)
  cliError(
    `${CROSS} ${tSync('plugins.marketplace.handleFailed', { action, error: errorMessage(error) })}`,
  )
}

function printValidationResult(result: ValidationResult): void {
  if (result.errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${CROSS} ${tSync('plugins.validate.foundErrors', { count: result.errors.length })}:\n`,
    )
    result.errors.forEach((error) => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${POINTER} ${error.path}: ${error.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
  if (result.warnings.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${WARNING} ${tSync('plugins.validate.foundWarnings', { count: result.warnings.length })}:\n`,
    )
    result.warnings.forEach((warning) => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${POINTER} ${warning.path}: ${warning.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
}

// 插件验证
export async function pluginValidateHandler(
  manifestPath: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  try {
    const result = await validateManifest(manifestPath)

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${tSync('plugins.validate.validatingManifest', { fileType: result.fileType, filePath: result.filePath })}\n`,
    )
    printValidationResult(result)

    // 如果是位于 .zy-plugin 目录内的插件清单，
    // 还需验证插件的内容文件（skills、agents、commands、hooks）。
    // 无论用户传入的是目录还是 plugin.json 路径均可工作。
    let contentResults: ValidationResult[] = []
    if (result.fileType === 'plugin') {
      const manifestDir = dirname(result.filePath)
      if (basename(manifestDir) === '.zy-plugin') {
        contentResults = await validatePluginContents(dirname(manifestDir))
        for (const r of contentResults) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(
            `${tSync('plugins.validate.validatingFile', { fileType: r.fileType, filePath: r.filePath })}\n`,
          )
          printValidationResult(r)
        }
      }
    }

    const allSuccess = result.success && contentResults.every((r) => r.success)
    const hasWarnings =
      result.warnings.length > 0 || contentResults.some((r) => r.warnings.length > 0)

    if (allSuccess) {
      cliOk(
        hasWarnings
          ? `${TICK} ${tSync('plugins.validate.passedWithWarnings')}`
          : `${TICK} ${tSync('plugins.validate.passed')}`,
      )
    } else {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`${CROSS} ${tSync('plugins.validate.failed')}`)
      process.exit(1)
    }
  } catch (error) {
    logError(error)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `${CROSS} ${tSync('plugins.validate.unexpectedError', { error: errorMessage(error) })}`,
    )
    process.exit(2)
  }
}

// 插件列表
export async function pluginListHandler(options: {
  json?: boolean
  available?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  logEvent('zy_plugin_list_command', {})

  const installedData = loadInstalledPlugins()
  const { getPluginEditableScopes } = await import('../../services/plugins/pluginStartupCheck.js')
  const enabledPlugins = getPluginEditableScopes()

  const pluginIds = Object.keys(installedData.plugins)

  // 一次性加载所有插件。JSON 和人类可读路径都需要：
  //  - loadErrors（显示每个插件的加载失败）
  //  - inline 插件（通过 --plugin-dir 的会话级插件，source='name@inline'）
  //    它们不在 installedData.plugins（V2 账簿）中 — 必须单独展示，
  //    否则 `plugin list` 会静默忽略 --plugin-dir。
  const {
    enabled: loadedEnabled,
    disabled: loadedDisabled,
    errors: loadErrors,
  } = await loadAllPlugins()
  const allLoadedPlugins = [...loadedEnabled, ...loadedDisabled]
  const inlinePlugins = allLoadedPlugins.filter((p) => p.source.endsWith('@inline'))
  // 路径级 inline 失败（目录不存在、清单读取前的解析错误）
  // 使用 source='inline[N]'。清单读取后的插件级错误使用
  // source='name@inline'。两者都收集到会话部分 — 否则不可见，
  // 因为它们没有 pluginId。
  const inlineLoadErrors = loadErrors.filter(
    (e) => e.source.endsWith('@inline') || e.source.startsWith('inline['),
  )

  if (options.json) {
    const plugins = await buildPluginListJsonEntries({
      allLoadedPlugins,
      enabledPlugins,
      inlineLoadErrors,
      inlinePlugins,
      installedData,
      loadErrors,
      pluginIds,
    })

    // 如果设置了 --available，还从 marketplace 加载可用插件
    if (options.available) {
      const available = await buildAvailablePluginListEntries()
      cliOk(jsonStringify({ installed: plugins, available }, null, 2))
    } else {
      cliOk(jsonStringify(plugins, null, 2))
    }
  }

  if (pluginIds.length === 0 && inlinePlugins.length === 0) {
    // inlineLoadErrors 可能在零个 inline 插件时存在（例如 --plugin-dir
    // 指向不存在的路径）。不要在此提前返回 — 继续进入会话部分
    // 以使失败可见。
    if (inlineLoadErrors.length === 0) {
      cliOk(tSync('plugins.list.noPlugins'))
    }
  }

  printPluginListReport({
    enabledPlugins,
    inlineLoadErrors,
    inlinePlugins,
    installedData,
    loadErrors,
    pluginIds,
  })

  cliOk()
}

// marketplace 添加
export async function marketplaceAddHandler(
  source: string,
  options: { cowork?: boolean; sparse?: string[]; scope?: string },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  try {
    const parsed = await parseMarketplaceInput(source)

    if (!parsed) {
      cliError(`${CROSS} ${tSync('plugins.marketplace.invalidSourceFormat')}`)
    }

    if ('error' in parsed) {
      cliError(`${CROSS} ${parsed.error}`)
    }

    // 验证作用域
    const scope = options.scope ?? 'user'
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      cliError(`${CROSS} ${tSync('plugins.marketplace.invalidScope', { scope })}`)
    }
    const settingSource = scopeToSettingSource(scope)

    let marketplaceSource = parsed

    if (options.sparse && options.sparse.length > 0) {
      if (marketplaceSource.source === 'github' || marketplaceSource.source === 'git') {
        marketplaceSource = {
          ...marketplaceSource,
          sparsePaths: options.sparse,
        }
      } else {
        cliError(
          `${CROSS} ${tSync('plugins.marketplace.sparseNotSupported', { source: marketplaceSource.source })}`,
        )
      }
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(tSync('plugins.marketplace.adding'))

    const { name, alreadyMaterialized, resolvedSource } = await addMarketplaceSource(
      marketplaceSource,
      (message) => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      },
    )

    // 将意图写入所请求作用域的设置中
    saveMarketplaceToSettings(name, { source: resolvedSource }, settingSource)

    clearAllCaches()

    let sourceType = marketplaceSource.source
    if (marketplaceSource.source === 'github') {
      sourceType =
        marketplaceSource.repo as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
    logEvent('zy_marketplace_added', {
      source_type: sourceType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(
      alreadyMaterialized
        ? `${TICK} ${tSync('plugins.marketplace.alreadyOnDisk', { name, scope })}`
        : `${TICK} ${tSync('plugins.marketplace.added', { name, scope })}`,
    )
  } catch (error) {
    handleMarketplaceError(error, 'add marketplace')
  }
}

// marketplace 列表
export async function marketplaceListHandler(options: {
  json?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  try {
    const config = await loadKnownMarketplacesConfig()
    const names = Object.keys(config)

    if (options.json) {
      const marketplaces = names.sort().map((name) => {
        const marketplace = config[name]
        const source = marketplace?.source
        return {
          name,
          source: source?.source,
          ...(source?.source === 'github' && { repo: source.repo }),
          ...(source?.source === 'git' && { url: source.url }),
          ...(source?.source === 'url' && { url: source.url }),
          ...(source?.source === 'directory' && { path: source.path }),
          ...(source?.source === 'file' && { path: source.path }),
          installLocation: marketplace?.installLocation,
        }
      })
      cliOk(jsonStringify(marketplaces, null, 2))
    }

    if (names.length === 0) {
      cliOk(tSync('plugins.marketplace.noneConfigured'))
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${tSync('plugins.marketplace.configured')}\n`)
    names.forEach((name) => {
      const marketplace = config[name]
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${POINTER} ${name}`)

      if (marketplace?.source) {
        const src = marketplace.source
        if (src.source === 'github') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    ${tSync('plugins.marketplace.sourceGithub', { repo: src.repo })}`)
        } else if (src.source === 'git') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    ${tSync('plugins.marketplace.sourceGit', { url: src.url })}`)
        } else if (src.source === 'url') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    ${tSync('plugins.marketplace.sourceUrl', { url: src.url })}`)
        } else if (src.source === 'directory') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    ${tSync('plugins.marketplace.sourceDirectory', { path: src.path })}`)
        } else if (src.source === 'file') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    ${tSync('plugins.marketplace.sourceFile', { path: src.path })}`)
        }
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    })

    cliOk()
  } catch (error) {
    handleMarketplaceError(error, 'list marketplaces')
  }
}

// marketplace 移除
export async function marketplaceRemoveHandler(
  name: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  try {
    await removeMarketplaceSource(name)
    clearAllCaches()

    logEvent('zy_marketplace_removed', {
      marketplace_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(`${TICK} ${tSync('plugins.marketplace.removed', { name })}`)
  } catch (error) {
    handleMarketplaceError(error, 'remove marketplace')
  }
}

// marketplace 更新
export async function marketplaceUpdateHandler(
  name: string | undefined,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  try {
    if (name) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(tSync('plugins.marketplace.updating', { name }))

      await refreshMarketplace(name, (message) => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      })

      clearAllCaches()

      logEvent('zy_marketplace_updated', {
        marketplace_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(`${TICK} ${tSync('plugins.marketplace.updated', { name })}`)
    } else {
      const config = await loadKnownMarketplacesConfig()
      const marketplaceNames = Object.keys(config)

      if (marketplaceNames.length === 0) {
        cliOk(tSync('plugins.marketplace.noneConfigured'))
      }

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(tSync('plugins.marketplace.updatingAll', { count: marketplaceNames.length }))

      await refreshAllMarketplaces()
      clearAllCaches()

      logEvent('zy_marketplace_updated_all', {
        count:
          marketplaceNames.length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(
        `${TICK} ${tSync('plugins.marketplace.updatedAll', { count: marketplaceNames.length })}`,
      )
    }
  } catch (error) {
    handleMarketplaceError(error, 'update marketplace(s)')
  }
}

// 插件安装
export async function pluginInstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError(tSync('plugins.common.coworkUserScopeOnly'))
  }
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as (typeof VALID_INSTALLABLE_SCOPES)[number])) {
    cliError(
      tSync('plugins.common.invalidInstallScope', {
        scope,
        valid: VALID_INSTALLABLE_SCOPES.join(', '),
      }),
    )
  }
  // _PROTO_* 路由到带 PII 标记的 plugin_name/marketplace_name BQ 列。
  // 未脱敏的插件参数之前被记录到所有用户的 general-access
  // additional_metadata 中 — 已删除，改用特权列路由。
  // marketplace 可能为 undefined（在解析前触发）。
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('zy_plugin_install_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name: marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await installPlugin(plugin, scope as 'user' | 'project' | 'local')
}

// 插件卸载
export async function pluginUninstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean; keepData?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError(tSync('plugins.common.coworkUserScopeOnly'))
  }
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as (typeof VALID_INSTALLABLE_SCOPES)[number])) {
    cliError(
      tSync('plugins.common.invalidInstallScope', {
        scope,
        valid: VALID_INSTALLABLE_SCOPES.join(', '),
      }),
    )
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('zy_plugin_uninstall_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name: marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await uninstallPlugin(plugin, scope as 'user' | 'project' | 'local', options.keepData)
}

// 插件启用
export async function pluginEnableHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number])
    ) {
      cliError(
        tSync('plugins.common.invalidScope', {
          scope: options.scope,
          valid: VALID_INSTALLABLE_SCOPES.join(', '),
        }),
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError(tSync('plugins.common.coworkUserScopeOnly'))
  }

  // --cowork 始终在 user 作用域下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('zy_plugin_enable_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name: marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await enablePlugin(plugin, scope)
}

// 插件禁用
export async function pluginDisableHandler(
  plugin: string | undefined,
  options: { scope?: string; cowork?: boolean; all?: boolean },
): Promise<void> {
  if (options.all && plugin) {
    cliError(tSync('plugins.disable.allWithPlugin'))
  }

  if (!options.all && !plugin) {
    cliError(tSync('plugins.disable.specifyPlugin'))
  }

  if (options.cowork) {
    setUseCoworkPlugins(true)
  }

  if (options.all) {
    if (options.scope) {
      cliError(tSync('plugins.disable.scopeWithAll'))
    }

    // 此处无 _PROTO_plugin_name — --all 禁用所有插件。
    // 通过 plugin_name IS NULL 与特定插件分支区分。
    logEvent('zy_plugin_disable_command', {})

    await disableAllPlugins()
    return
  }

  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number])
    ) {
      cliError(
        tSync('plugins.common.invalidScope', {
          scope: options.scope,
          valid: VALID_INSTALLABLE_SCOPES.join(', '),
        }),
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError(tSync('plugins.common.coworkUserScopeOnly'))
  }

  // --cowork 始终在 user 作用域下操作
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin!)
  logEvent('zy_plugin_disable_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name: marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await disablePlugin(plugin!, scope)
}

// 插件更新
export async function pluginUpdateHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) {
    setUseCoworkPlugins(true)
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('zy_plugin_update_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name: marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
  })

  let scope: (typeof VALID_UPDATE_SCOPES)[number] = 'user'
  if (options.scope) {
    if (!VALID_UPDATE_SCOPES.includes(options.scope as (typeof VALID_UPDATE_SCOPES)[number])) {
      cliError(
        tSync('plugins.common.invalidScope', {
          scope: options.scope,
          valid: VALID_UPDATE_SCOPES.join(', '),
        }),
      )
    }
    scope = options.scope as (typeof VALID_UPDATE_SCOPES)[number]
  }
  if (options.cowork && scope !== 'user') {
    cliError(tSync('plugins.common.coworkUserScopeOnly'))
  }

  await updatePluginCli(plugin, scope)
}
