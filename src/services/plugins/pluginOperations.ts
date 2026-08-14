/**
 * 插件核心操作（安装、卸载、启用、禁用、更新）
 *
 * 本模块提供可供以下两者使用的纯库函数：
 * - CLI 命令（`zy plugin install/uninstall/enable/disable/update`）
 * - 交互式 UI（ManagePlugins.tsx）
 *
 * 本模块中的函数：
 * - 不调用 process.exit()
 * - 不向控制台写入内容
 * - 返回包含成功/失败状态和消息的结果对象
 * - 遇到意外失败时可抛出错误
 */
import { dirname, join } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { isBuiltinPluginId } from './builtinRegistry.js'
import type { LoadedPlugin, PluginManifest } from './types.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { logError } from '../../services/infra/log.js'
import { clearAllCaches, markPluginVersionOrphaned } from './cacheUtils.js'
import { findReverseDependents, formatReverseDependentsSuffix } from './dependencyResolver.js'
import {
  loadInstalledPlugins,
  loadInstalledPluginsFromDisk,
  removePluginInstallation,
  updateInstallationPathOnDisk,
} from './installedPluginsManager.js'
import { getMarketplace, getPluginById, loadKnownMarketplacesConfig } from './marketplaceManager.js'
import { deletePluginDataDir } from './pluginDirectories.js'
import { parsePluginIdentifier, scopeToSettingSource } from './pluginIdentifier.js'
import { formatResolutionError, installResolvedPlugin } from './pluginInstallationHelpers.js'
import {
  cachePlugin,
  copyPluginToVersionedCache,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPlugins,
  loadPluginManifest,
} from './pluginLoader.js'
import { deletePluginOptions } from './pluginOptionsStorage.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'
import { getPluginEditableScopes } from './pluginStartupCheck.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import type { PluginMarketplaceEntry, PluginScope } from './schemas.js'
import { getSettingsForSource, updateSettingsForSource } from '../settings/settings.js'
import { plural } from '../../utils/stringUtils.js'

/** 有效的可安装作用域（不包括只能从 managed-settings.json 安装的 'managed'） */
export const VALID_INSTALLABLE_SCOPES = ['user', 'project', 'local'] as const

/** 从 VALID_INSTALLABLE_SCOPES 派生的安装作用域类型 */
export type InstallableScope = (typeof VALID_INSTALLABLE_SCOPES)[number]

/** 更新操作的有效作用域（包括 'managed'，因为托管插件可以更新） */
export const VALID_UPDATE_SCOPES: readonly PluginScope[] = [
  'user',
  'project',
  'local',
  'managed',
] as const

/**
 * 在运行时断言作用域是有效的可安装作用域。
 * @param scope 要验证的作用域
 * @throws 如果作用域不是有效的可安装作用域则抛出 Error
 */
export function assertInstallableScope(scope: string): asserts scope is InstallableScope {
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)) {
    throw new Error(
      `Invalid scope "${scope}". Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
    )
  }
}

/**
 * 用于检查作用域是否为可安装作用域（非 'managed'）的类型守卫。
 * 在条件块中使用它缩窄类型。
 */
export function isInstallableScope(scope: PluginScope): scope is InstallableScope {
  return VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)
}

/**
 * 获取项目专属作用域的项目路径。
 * 对 'project' 和 'local' 作用域返回原始 cwd，否则返回 undefined。
 */
export function getProjectPathForScope(scope: PluginScope): string | undefined {
  return scope === 'project' || scope === 'local' ? getOriginalCwd() : undefined
}

/**
 * 此插件在 .zy/settings.json 中是否已启用（value === true）？
 *
 * 这不同于 V2 installed_plugins.json 中的作用域：该文件记录插件*从何处安装*，
 * 但同一插件也可以通过设置在项目作用域启用。卸载 UI 需要检查这里，因为用户
 * 作用域安装加上项目作用域启用时，“卸载”会成功移除用户安装，却保留项目作用域
 * 的启用状态，插件仍会运行。
 */
export function isPluginEnabledAtProjectScope(pluginId: string): boolean {
  return getSettingsForSource('projectSettings')?.enabledPlugins?.[pluginId] === true
}

// ============================================================================
// 结果类型
// ============================================================================

/**
 * 插件操作的结果
 */
export type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  /** 将此插件声明为依赖项的插件（卸载/禁用时警告） */
  reverseDependents?: string[]
}

/**
 * 插件更新操作的结果
 */
export type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在所有可编辑设置作用域中搜索与给定输入匹配的插件 ID。
 *
 * 如果 `plugin` 包含 `@`，则将其视为完整 pluginId，并在任一作用域找到时返回。
 * 如果 `plugin` 是裸名称，则搜索任一作用域中以 `{plugin}@` 开头的键。
 *
 * 返回提及该插件的最具体作用域（不论启用/禁用状态）及解析出的完整 pluginId。
 *
 * 优先级：local > project > user（最具体者优先）。
 */
function findPluginInSettings(plugin: string): {
  pluginId: string
  scope: InstallableScope
} | null {
  const hasMarketplace = plugin.includes('@')
  // 最具体者优先，第一个匹配项胜出
  const searchOrder: InstallableScope[] = ['local', 'project', 'user']

  for (const scope of searchOrder) {
    const enabledPlugins = getSettingsForSource(scopeToSettingSource(scope))?.enabledPlugins
    if (!enabledPlugins) {
      continue
    }

    for (const key of Object.keys(enabledPlugins)) {
      if (hasMarketplace ? key === plugin : key.startsWith(`${plugin}@`)) {
        return { pluginId: key, scope }
      }
    }
  }
  return null
}

/**
 * 从已加载插件中查找插件的辅助函数
 */
function findPluginByIdentifier(plugin: string, plugins: LoadedPlugin[]): LoadedPlugin | undefined {
  const { name, marketplace } = parsePluginIdentifier(plugin)

  return plugins.find((p) => {
    // 检查名称是否精确匹配
    if (p.name === plugin || p.name === name) {
      return true
    }

    // 如果指定了 marketplace，检查其是否与来源匹配
    if (marketplace && p.source) {
      return p.name === name && p.source.includes(`@${marketplace}`)
    }

    return false
  })
}

/**
 * 为可能已从其 marketplace 下架的插件，从 V2 已安装插件数据中解析插件 ID。
 * 如果未在 V2 数据中找到该插件则返回 null。
 */
function resolveDelistedPluginId(plugin: string): { pluginId: string; pluginName: string } | null {
  const { name } = parsePluginIdentifier(plugin)
  const installedData = loadInstalledPlugins()

  // 先尝试精确匹配，再按名称搜索
  if (installedData.plugins[plugin]?.length) {
    return { pluginId: plugin, pluginName: name }
  }

  const matchingKey = Object.keys(installedData.plugins).find((key) => {
    const { name: keyName } = parsePluginIdentifier(key)
    return keyName === name && (installedData.plugins[key]?.length ?? 0) > 0
  })

  if (matchingKey) {
    return { pluginId: matchingKey, pluginName: name }
  }

  return null
}

/**
 * 从 V2 数据中获取插件最相关的安装记录。
 * 对项目/local 作用域插件，优先选择与当前项目匹配的安装记录。
 * 优先级：local（匹配项目）> project（匹配项目）> user > 第一个可用记录
 */
export function getPluginInstallationFromV2(pluginId: string): {
  scope: PluginScope
  projectPath?: string
} {
  const installedData = loadInstalledPlugins()
  const installations = installedData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return { scope: 'user' }
  }

  const currentProjectPath = getOriginalCwd()

  // 按优先级查找安装记录：local > project > user > managed
  const localInstall = installations.find(
    (inst) => inst.scope === 'local' && inst.projectPath === currentProjectPath,
  )
  if (localInstall) {
    return { scope: localInstall.scope, projectPath: localInstall.projectPath }
  }

  const projectInstall = installations.find(
    (inst) => inst.scope === 'project' && inst.projectPath === currentProjectPath,
  )
  if (projectInstall) {
    return {
      scope: projectInstall.scope,
      projectPath: projectInstall.projectPath,
    }
  }

  const userInstall = installations.find((inst) => inst.scope === 'user')
  if (userInstall) {
    return { scope: userInstall.scope }
  }

  // 回退到第一个安装记录（可能为 managed）
  return {
    scope: installations[0]!.scope,
    projectPath: installations[0]!.projectPath,
  }
}

// ============================================================================
// 核心操作
// ============================================================================

/**
 * 安装插件（设置优先）。
 *
 * 操作顺序：
 *   1. 在已物化的 marketplace 中搜索插件
 *   2. 写入设置（实际操作：声明意图）
 *   3. 缓存插件并记录版本提示（物化）
 *
 * marketplace 对账不属于此函数职责；启动时的 reconcile 会处理已声明但尚未物化
 * 的 marketplace。如果找不到 marketplace，返回“未找到”就是正确的错误。
 *
 * @param plugin 插件标识符（名称或 plugin@marketplace）
 * @param scope 安装作用域：user、project 或 local（默认为 'user'）
 * @returns 表示成功/失败的结果
 */
export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<PluginOperationResult> {
  assertInstallableScope(scope)

  const { name: pluginName, marketplace: marketplaceName } = parsePluginIdentifier(plugin)

  // ── 在已物化的 marketplace 中搜索插件 ──
  let foundPlugin: PluginMarketplaceEntry | undefined
  let foundMarketplace: string | undefined
  let marketplaceInstallLocation: string | undefined

  if (marketplaceName) {
    const pluginInfo = await getPluginById(plugin)
    if (pluginInfo) {
      foundPlugin = pluginInfo.entry
      foundMarketplace = marketplaceName
      marketplaceInstallLocation = pluginInfo.marketplaceInstallLocation
    }
  } else {
    const marketplaces = await loadKnownMarketplacesConfig()
    for (const [mktName, mktConfig] of Object.entries(marketplaces)) {
      try {
        const marketplace = await getMarketplace(mktName)
        const pluginEntry = marketplace.plugins.find((p: { name: string }) => p.name === pluginName)
        if (pluginEntry) {
          foundPlugin = pluginEntry
          foundMarketplace = mktName
          marketplaceInstallLocation = mktConfig.installLocation
          break
        }
      } catch (error) {
        logError(toError(error))
      }
    }
  }

  if (!foundPlugin || !foundMarketplace) {
    const location = marketplaceName
      ? `marketplace "${marketplaceName}"`
      : 'any configured marketplace'
    return {
      success: false,
      message: `Plugin "${pluginName}" not found in ${location}`,
    }
  }

  const entry = foundPlugin
  const pluginId = `${entry.name}@${foundMarketplace}`

  const result = await installResolvedPlugin({
    pluginId,
    entry,
    scope,
    marketplaceInstallLocation,
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'local-source-no-location':
        return {
          success: false,
          message: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
        }
      case 'settings-write-failed':
        return {
          success: false,
          message: `Failed to update settings: ${result.message}`,
        }
      case 'resolution-failed':
        return {
          success: false,
          message: formatResolutionError(result.resolution),
        }
      case 'blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
        }
      case 'dependency-blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${result.pluginName}" depends on "${result.blockedDependency}", which is blocked by your organization's policy`,
        }
    }
  }

  return {
    success: true,
    message: `Successfully installed plugin: ${pluginId} (scope: ${scope})${result.depNote}`,
    pluginId,
    pluginName: entry.name,
    scope,
  }
}

/**
 * 卸载插件
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 要卸载的作用域：user、project 或 local（默认为 'user'）
 * @returns 表示成功/失败的结果
 */
export async function uninstallPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
  deleteDataDir = true,
): Promise<PluginOperationResult> {
  // 在运行时验证作用域，以便尽早发现错误
  assertInstallableScope(scope)

  const { enabled, disabled } = await loadAllPlugins()
  const allPlugins = [...enabled, ...disabled]

  // 查找插件
  const foundPlugin = findPluginByIdentifier(plugin, allPlugins)

  const settingSource = scopeToSettingSource(scope)
  const settings = getSettingsForSource(settingSource)

  let pluginId: string
  let pluginName: string

  if (foundPlugin) {
    // 查找此插件对应的设置键（若用户提供短名称而设置使用 plugin@marketplace，
    // 则可能与 `plugin` 不同）
    pluginId =
      Object.keys(settings?.enabledPlugins ?? {}).find(
        (k) => k === plugin || k === foundPlugin.name || k.startsWith(`${foundPlugin.name}@`),
      ) ?? (plugin.includes('@') ? plugin : foundPlugin.name)
    pluginName = foundPlugin.name
  } else {
    // 无法通过 marketplace 查找插件，它可能已下架。
    // 回退到独立于 marketplace 状态跟踪安装记录的 installed_plugins.json（V2）。
    const resolved = resolveDelistedPluginId(plugin)
    if (!resolved) {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in installed plugins`,
      }
    }
    pluginId = resolved.pluginId
    pluginName = resolved.pluginName
  }

  // 检查该插件是否已安装在此作用域（V2 文件中）
  const projectPath = getProjectPathForScope(scope)
  const installedData = loadInstalledPlugins()
  const installations = installedData.plugins[pluginId]
  const scopeInstallation = installations?.find(
    (i) => i.scope === scope && i.projectPath === projectPath,
  )

  if (!scopeInstallation) {
    // 尝试找到插件实际安装的位置，以提供有帮助的错误信息
    const { scope: actualScope } = getPluginInstallationFromV2(pluginId)
    if (actualScope !== scope && installations && installations.length > 0) {
      // 项目作用域较特殊：.zy/settings.json 与团队共享。
      // 引导用户使用本地覆盖方案，而不是 --scope project。
      if (actualScope === 'project') {
        return {
          success: false,
          message: `Plugin "${plugin}" is enabled at project scope (.zy/settings.json, shared with your team). To disable just for you: zy plugin disable ${plugin} --scope local`,
        }
      }
      return {
        success: false,
        message: `Plugin "${plugin}" is installed in ${actualScope} scope, not ${scope}. Use --scope ${actualScope} to uninstall.`,
      }
    }
    return {
      success: false,
      message: `Plugin "${plugin}" is not installed in ${scope} scope. Use --scope to specify the correct scope.`,
    }
  }

  const installPath = scopeInstallation.installPath

  // 从相应设置文件中移除插件（完全删除键）
  // 通过 undefined 向 updateSettingsForSource 中的 mergeWith 表示删除
  const newEnabledPlugins: Record<string, boolean | string[] | undefined> = {
    ...settings?.enabledPlugins,
  }
  newEnabledPlugins[pluginId] = undefined
  updateSettingsForSource(settingSource, {
    enabledPlugins: newEnabledPlugins,
  })

  clearAllCaches()

  // 从此作用域的 installed_plugins_v2.json 中移除
  removePluginInstallation(pluginId, scope, projectPath)

  const updatedData = loadInstalledPlugins()
  const remainingInstallations = updatedData.plugins[pluginId]
  const isLastScope = !remainingInstallations || remainingInstallations.length === 0
  if (isLastScope && installPath) {
    await markPluginVersionOrphaned(installPath)
  }
  // 此逻辑独立于上方的 `&& installPath` 守卫：deletePluginOptions 只需要
  // pluginId，而不需要 installPath。移除最后一个作用域后，清除保存的选项和
  // 密钥。此前卸载会永久遗留 settings.pluginConfigs 中的孤立条目（包括 MCPB
  // Configure 流程的旧版未门控 mcpServers 子键）及 keychain pluginSecrets。
  // 无需功能开关：未保存内容时 deletePluginOptions 不执行操作，且
  // pluginConfigs.mcpServers 的写入未受门控，因此清理也必须未受门控。
  if (isLastScope) {
    deletePluginOptions(pluginId)
    if (deleteDataDir) {
      await deletePluginDataDir(pluginId)
    }
  }

  // 如果其他已启用插件依赖此插件，则警告（但不阻止操作）。
  // 阻止操作会产生墓碑记录，无法拆除含有已下架插件的图。加载时的
  // verifyAndDemote 会处理后续影响。
  const reverseDependents = findReverseDependents(pluginId, allPlugins)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)

  return {
    success: true,
    message: `Successfully uninstalled plugin: ${pluginName} (scope: ${scope})${depWarn}`,
    pluginId,
    pluginName,
    scope,
    reverseDependents: reverseDependents.length > 0 ? reverseDependents : undefined,
  }
}

/**
 * 设置插件启用/禁用状态（设置优先）。
 *
 * 从设置解析插件 ID 和作用域，不会预先依赖 installed_plugins.json 进行判断。
 * 设置声明意图；如果插件尚未缓存，下一次加载会将其缓存。
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param enabled true 表示启用，false 表示禁用
 * @param scope 可选作用域。未提供时，自动检测设置中提及该插件的最具体作用域。
 * @returns 表示成功/失败的结果
 */
export async function setPluginEnabledOp(
  plugin: string,
  enabled: boolean,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  const operation = enabled ? 'enable' : 'disable'

  // 内置插件始终使用用户作用域设置，跳过常规的作用域解析和
  // installed_plugins 查找（它们无需安装）。
  if (isBuiltinPluginId(plugin)) {
    const { error } = updateSettingsForSource('userSettings', {
      enabledPlugins: {
        ...getSettingsForSource('userSettings')?.enabledPlugins,
        [plugin]: enabled,
      },
    })
    if (error) {
      return {
        success: false,
        message: `Failed to ${operation} built-in plugin: ${error.message}`,
      }
    }
    clearAllCaches()
    const { name: pluginName } = parsePluginIdentifier(plugin)
    return {
      success: true,
      message: `Successfully ${operation}d built-in plugin: ${pluginName}`,
      pluginId: plugin,
      pluginName,
      scope: 'user',
    }
  }

  if (scope) {
    assertInstallableScope(scope)
  }

  // ── 从设置解析 pluginId 和作用域 ──
  // 在可编辑作用域中搜索对此插件的任意提及（启用或禁用）。不预先依赖
  // installed_plugins.json 进行判断。
  let pluginId: string
  let resolvedScope: InstallableScope

  const found = findPluginInSettings(plugin)

  if (scope) {
    // 显式作用域：直接使用它。尽可能从设置解析 pluginId，否则要求提供完整的
    // plugin@marketplace 标识符。
    resolvedScope = scope
    if (found) {
      pluginId = found.pluginId
    } else if (plugin.includes('@')) {
      pluginId = plugin
    } else {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in settings. Use plugin@marketplace format.`,
      }
    }
  } else if (found) {
    // 自动检测作用域：使用设置中提及该插件的最具体作用域。
    pluginId = found.pluginId
    resolvedScope = found.scope
  } else if (plugin.includes('@')) {
    // 不在任何设置作用域中，但提供了完整 pluginId：默认使用用户作用域（与安装
    // 默认值一致）。这允许启用已缓存但从未声明的插件。
    pluginId = plugin
    resolvedScope = 'user'
  } else {
    return {
      success: false,
      message: `Plugin "${plugin}" not found in any editable settings scope. Use plugin@marketplace format.`,
    }
  }

  // ── 策略守卫 ──
  // 被组织策略阻止的插件不能在任何作用域启用。解析 pluginId 后再检查，以覆盖
  // 完整标识符和裸名称查找。
  if (enabled && isPluginBlockedByPolicy(pluginId)) {
    return {
      success: false,
      message: `Plugin "${pluginId}" is blocked by your organization's policy and cannot be enabled`,
    }
  }

  const settingSource = scopeToSettingSource(resolvedScope)
  const scopeSettingsValue = getSettingsForSource(settingSource)?.enabledPlugins?.[pluginId]

  // ── 跨作用域提示：已指定作用域但插件位于其他作用域 ──
  // 如果请求作用域中没有插件、但其他作用域中存在，则引导用户使用正确的 --scope；
  // 但写入更高优先级作用域以覆盖较低优先级作用域时除外（例如，使用
  // `disable --scope local` 覆盖项目作用域已启用的插件，而不修改共享的
  // .zy/settings.json）。
  const SCOPE_PRECEDENCE: Record<InstallableScope, number> = {
    user: 0,
    project: 1,
    local: 2,
  }
  const isOverride = scope && found && SCOPE_PRECEDENCE[scope] > SCOPE_PRECEDENCE[found.scope]
  if (scope && scopeSettingsValue === undefined && found && found.scope !== scope && !isOverride) {
    return {
      success: false,
      message: `Plugin "${plugin}" is installed at ${found.scope} scope, not ${scope}. Use --scope ${found.scope} or omit --scope to auto-detect.`,
    }
  }

  // ── 检查当前状态（用于幂等性消息） ──
  // 指定显式作用域时：直接检查该作用域的设置值（如果插件在其他作用域启用、此处
  // 禁用，合并状态可能不正确）。自动检测时：使用合并后的有效状态。覆盖较低
  // 作用域时：检查合并状态；此时 scopeSettingsValue 为 undefined（插件尚未位于
  // 此作用域），会被视为“已禁用”，但覆盖的目的正是写入显式 `false` 来遮蔽较低
  // 作用域的 `true`。
  const isCurrentlyEnabled =
    scope && !isOverride ? scopeSettingsValue === true : getPluginEditableScopes().has(pluginId)
  if (enabled === isCurrentlyEnabled) {
    return {
      success: false,
      message: `Plugin "${plugin}" is already ${enabled ? 'enabled' : 'disabled'}${scope ? ` at ${scope} scope` : ''}`,
    }
  }

  // 禁用时：在写入设置并清除记忆化插件缓存前，从禁用前快照捕获反向依赖项。
  let reverseDependents: string[] | undefined
  if (!enabled) {
    const { enabled: loadedEnabled, disabled } = await loadAllPlugins()
    const rdeps = findReverseDependents(pluginId, [...loadedEnabled, ...disabled])
    if (rdeps.length > 0) {
      reverseDependents = rdeps
    }
  }

  // ── 操作：写入设置 ──
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...getSettingsForSource(settingSource)?.enabledPlugins,
      [pluginId]: enabled,
    },
  })
  if (error) {
    return {
      success: false,
      message: `Failed to ${operation} plugin: ${error.message}`,
    }
  }

  clearAllCaches()

  const { name: pluginName } = parsePluginIdentifier(pluginId)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)
  return {
    success: true,
    message: `Successfully ${operation}d plugin: ${pluginName} (scope: ${resolvedScope})${depWarn}`,
    pluginId,
    pluginName,
    scope: resolvedScope,
    reverseDependents,
  }
}

/**
 * 启用插件
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域。未提供时，查找当前项目的最具体作用域。
 * @returns 表示成功/失败的结果
 */
export async function enablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, true, scope)
}

/**
 * 禁用插件
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域。未提供时，查找当前项目的最具体作用域。
 * @returns 表示成功/失败的结果
 */
export async function disablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, false, scope)
}

/**
 * 禁用全部已启用插件
 *
 * @returns 包含已禁用插件数量的成功/失败结果
 */
export async function disableAllPluginsOp(): Promise<PluginOperationResult> {
  const enabledPlugins = getPluginEditableScopes()

  if (enabledPlugins.size === 0) {
    return { success: true, message: 'No enabled plugins to disable' }
  }

  const disabled: string[] = []
  const errors: string[] = []

  for (const [pluginId] of enabledPlugins) {
    const result = await setPluginEnabledOp(pluginId, false)
    if (result.success) {
      disabled.push(pluginId)
    } else {
      errors.push(`${pluginId}: ${result.message}`)
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}, ${errors.length} failed:\n${errors.join('\n')}`,
    }
  }

  return {
    success: true,
    message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}`,
  }
}

/**
 * 将插件更新到最新版本。
 *
 * 此函数执行非原地更新：
 * 1. 从 marketplace 获取插件信息
 * 2. 对远程插件：下载到临时目录并计算版本
 * 3. 对本地插件：根据 marketplace 来源计算版本
 * 4. 若版本不同于当前安装版本，复制到新的版本化缓存目录
 * 5. 更新 V2 文件中的安装记录（内存在重启前保持不变）
 * 6. 若旧版本不再被任何安装记录引用，则清理它
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 要更新的作用域。不同于安装/卸载/启用/禁用，允许 managed 作用域。
 * @returns 包含版本信息的成功/失败结果
 */
export async function updatePluginOp(
  plugin: string,
  scope: PluginScope,
): Promise<PluginUpdateResult> {
  // 解析插件标识符以获取完整插件 ID
  const { name: pluginName, marketplace: marketplaceName } = parsePluginIdentifier(plugin)
  const pluginId = marketplaceName ? `${pluginName}@${marketplaceName}` : plugin

  // 从 marketplace 获取插件信息
  const pluginInfo = await getPluginById(plugin)
  if (!pluginInfo) {
    return {
      success: false,
      message: `Plugin "${pluginName}" not found`,
      pluginId,
      scope,
    }
  }

  const { entry, marketplaceInstallLocation } = pluginInfo

  // 从磁盘获取安装记录
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed`,
      pluginId,
      scope,
    }
  }

  // 根据作用域确定 projectPath
  const projectPath = getProjectPathForScope(scope)

  // 查找此作用域的安装记录
  const installation = installations.find(
    (inst) => inst.scope === scope && inst.projectPath === projectPath,
  )
  if (!installation) {
    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed at scope ${scopeDesc}`,
      pluginId,
      scope,
    }
  }

  return performPluginUpdate({
    pluginId,
    pluginName,
    entry,
    marketplaceInstallLocation,
    installation,
    scope,
    projectPath,
  })
}

/**
 * 执行实际插件更新：获取来源、计算版本、复制到缓存、更新磁盘。
 * 这是从 updatePluginOp 提取出的核心更新执行逻辑。
 */
async function performPluginUpdate({
  pluginId,
  pluginName,
  entry,
  marketplaceInstallLocation,
  installation,
  scope,
  projectPath,
}: {
  pluginId: string
  pluginName: string
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  installation: { version?: string; installPath: string }
  scope: PluginScope
  projectPath: string | undefined
}): Promise<PluginUpdateResult> {
  const fs = getFsImplementation()
  const oldVersion = installation.version

  let sourcePath: string
  let newVersion: string
  let shouldCleanupSource = false
  let gitCommitSha: string | undefined

  // 处理远程与本地插件
  if (typeof entry.source !== 'string') {
    // 远程插件：先下载到临时目录
    const cacheResult = await cachePlugin(entry.source, {
      manifest: { name: entry.name },
    })
    sourcePath = cacheResult.path
    shouldCleanupSource = true
    gitCommitSha = cacheResult.gitCommitSha

    // 根据下载的插件计算版本。对 git-subdir 来源，cachePlugin 会在丢弃临时 clone
    // 前捕获提交 SHA（提取的子目录没有 .git，因此 calculatePluginVersion 中基于
    // installPath 的回退方案无法恢复它）。
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      cacheResult.manifest,
      cacheResult.path,
      entry.version,
      cacheResult.gitCommitSha,
    )
  } else {
    // 本地插件：使用 marketplace 中的路径
    // 直接 stat：内联处理 ENOENT，而不是预先检查是否存在
    let marketplaceStats
    try {
      marketplaceStats = await fs.stat(marketplaceInstallLocation)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Marketplace directory not found at ${marketplaceInstallLocation}`,
          pluginId,
          scope,
        }
      }
      throw e
    }
    const marketplaceDir = marketplaceStats.isDirectory()
      ? marketplaceInstallLocation
      : dirname(marketplaceInstallLocation)
    sourcePath = join(marketplaceDir, entry.source)

    // 验证 sourcePath 是否存在。必须执行此 stat，因为下游操作均不能可靠地暴露
    // ENOENT：1. calculatePluginVersion → findGitRoot 会越过不存在的目录向上查找
    // marketplace .git，返回与安装时相同的 SHA，导致静默误报
    // {success: true, alreadyUpToDate: true}；2. copyPluginToVersionedCache
    // （版本不同时）会抛出没有友好消息的原始 ENOENT。对于用户管理的本地目录，
    // TOCTOU 的影响可以忽略。
    try {
      await fs.stat(sourcePath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Plugin source not found at ${sourcePath}`,
          pluginId,
          scope,
        }
      }
      throw e
    }

    // 尝试从插件目录加载 manifest（用于获取版本信息）
    let pluginManifest: PluginManifest | undefined
    const manifestPath = join(sourcePath, '.zy-plugin', 'plugin.json')
    try {
      pluginManifest = await loadPluginManifest(manifestPath, entry.name, entry.source)
    } catch {
      // 加载失败，改用其他版本来源
    }

    // 根据插件源路径计算版本
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      pluginManifest,
      sourcePath,
      entry.version,
    )
  }

  // 使用 try/finally 确保发生任何错误时都清理临时目录
  try {
    // 检查缓存中是否已存在此版本
    let versionedPath = getVersionedCachePath(pluginId, newVersion)

    // 检查安装记录是否已经是新版本
    const zipPath = getVersionedZipCachePath(pluginId, newVersion)
    const isUpToDate =
      installation.version === newVersion ||
      installation.installPath === versionedPath ||
      installation.installPath === zipPath
    if (isUpToDate) {
      return {
        success: true,
        message: `${pluginName} is already at the latest version (${newVersion}).`,
        pluginId,
        newVersion,
        oldVersion,
        alreadyUpToDate: true,
        scope,
      }
    }

    // 复制到版本化缓存（返回实际路径，可能是 .zip）
    versionedPath = await copyPluginToVersionedCache(sourcePath, pluginId, newVersion, entry)

    // 保存旧版本路径，以备后续清理
    const oldVersionPath = installation.installPath

    // 更新此安装记录的磁盘 JSON 文件（内存在重启前保持不变）
    updateInstallationPathOnDisk(
      pluginId,
      scope,
      projectPath,
      versionedPath,
      newVersion,
      gitCommitSha,
    )

    if (oldVersionPath && oldVersionPath !== versionedPath) {
      const updatedDiskData = loadInstalledPluginsFromDisk()
      const isOldVersionStillReferenced = Object.values(updatedDiskData.plugins).some(
        (pluginInstallations) =>
          pluginInstallations.some((inst) => inst.installPath === oldVersionPath),
      )

      if (!isOldVersionStillReferenced) {
        await markPluginVersionOrphaned(oldVersionPath)
      }
    }

    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    const message = `Plugin "${pluginName}" updated from ${oldVersion || 'unknown'} to ${newVersion} for scope ${scopeDesc}. Restart to apply changes.`

    return {
      success: true,
      message,
      pluginId,
      newVersion,
      oldVersion,
      scope,
    }
  } finally {
    // 如果来源是远程下载，则清理临时来源目录
    if (shouldCleanupSource && sourcePath !== getVersionedCachePath(pluginId, newVersion)) {
      await fs.rm(sourcePath, { recursive: true, force: true })
    }
  }
}
