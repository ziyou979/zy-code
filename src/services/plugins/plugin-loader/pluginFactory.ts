/**
 * 插件加载器模块
 *
 * 本模块负责从各种来源（包括 marketplace 和 git 仓库）发现、加载和验证 ZY Code 插件。
 *
 * 也支持 NPM 包，但必须通过 marketplace 引用 — marketplace 条目包含 NPM 包信息。
 *
 * 插件发现来源（按优先级排列）：
 * 1. 基于 Marketplace 的插件（settings 中的 plugin@marketplace 格式）
 * 2. 仅会话插件（来自 --plugin-dir CLI 标志或 SDK plugins 选项）
 *
 * 插件目录结构：
 * ```
 * my-plugin/
 * ├── plugin.json          # 可选的包含元数据的清单文件
 * ├── commands/            # 自定义斜杠命令
 * │   ├── build.md
 * │   └── deploy.md
 * ├── agents/              # 自定义 AI 代理
 * │   └── test-runner.md
 * └── hooks/               # Hook 配置
 *     └── hooks.json       # Hook 定义
 * ```
 *
 * 加载器处理：
 * - 插件清单验证
 * - Hook 配置加载和变量解析
 * - 重复名称检测
 * - 启用/禁用状态管理
 * - 错误收集和报告
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_MARKETPLACE_NAME } from '../builtinRegistry.js'
import type { LoadedPlugin, PluginError, PluginManifest } from '../types.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, isFsInaccessible, toError } from '../../utils/errors.js'
import { pathExists } from '../../utils/file.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../settings/settings.js'
import type { HooksSettings } from '../../settings/types.js'
import { SettingsSchema } from '../../settings/types.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getAddDirEnabledPlugins } from '../addDirPluginSettings.js'
import { getInMemoryInstalledPlugins } from '../installedPluginsManager.js'
import {
  formatSourceForDisplay,
  getBlockedMarketplaces,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from '../marketplaceHelpers.js'
import {
  getMarketplaceCacheOnly,
  getPluginByIdCacheOnly,
  loadKnownMarketplacesConfigSafe,
} from '../marketplaceManager.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import { calculatePluginVersion } from '../pluginVersioning.js'
import { PluginIdSchema, type PluginMarketplaceEntry } from '../schemas.js'
import {
  extractZipToDirectory,
  getSessionPluginCachePath,
  isPluginZipCacheEnabled,
} from '../zipCache.js'
import {
  copyPluginToVersionedCache,
  getVersionedCachePath,
  getVersionedZipCachePath,
  probeSeedCache,
  probeSeedCacheAnyVersion,
} from './cachePaths.js'
import { cachePlugin, loadPluginManifest } from './sourceInstallers.js'
import { finishLoadingPluginFromPath, isRecord } from './marketplaceLoading.js'
/**
 * 将 manifest 中的 monitors 配置规范化为统一的数组格式。
 * 支持三种输入：字符串路径（暂忽略）、对象数组、对象映射。
 */
export function parseMonitorConfigs(
  monitors: unknown,
  pluginName: string,
): LoadedPlugin['monitors'] {
  if (typeof monitors === 'string') {
    // 路径格式：指向外部 JSON，后续可扩展
    logForDebugging(
      `Plugin "${pluginName}" monitors configured as path "${monitors}" — file-based loading not yet supported, skipping`,
    )
    return undefined
  }

  if (Array.isArray(monitors)) {
    // 数组格式：直接使用已验证的 MonitorConfig 对象
    return monitors.filter(
      (m): m is NonNullable<LoadedPlugin['monitors']>[number] =>
        typeof m === 'object' && m !== null && typeof m.command === 'string',
    )
  }

  if (typeof monitors === 'object' && monitors !== null) {
    // 对象映射格式：{ "monitorName": { command, trigger, ... } }
    return Object.entries(monitors)
      .filter(([, config]) => typeof config === 'object' && config !== null)
      .map(([name, config]) => ({
        name,
        command: (config as Record<string, unknown>).command as string,
        trigger: (config as Record<string, unknown>).trigger as
          | 'session_start'
          | 'skill_invoke'
          | undefined,
        cwd: (config as Record<string, unknown>).cwd as string | undefined,
        env: (config as Record<string, unknown>).env as Record<string, string> | undefined,
      }))
      .filter((m) => typeof m.command === 'string' && m.command.length > 0)
  }

  return undefined
}

/**
 * 从 SettingsSchema 派生的 Schema，仅保留允许插件设置的键。
 * 使用 .strip() 以便在解析期间静默移除未知键。
 */
export const PluginSettingsSchema = lazySchema(() =>
  SettingsSchema()
    .pick({
      agent: true,
    })
    .strip(),
)

/**
 * 通过 PluginSettingsSchema 解析原始设置，仅返回白名单中的键。
 * 如果解析失败或所有键都被过滤掉则返回 undefined。
 */
export function parsePluginSettings(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const result = PluginSettingsSchema().safeParse(raw)
  if (!result.success) {
    return undefined
  }
  const data = result.data
  if (Object.keys(data).length === 0) {
    return undefined
  }
  return data
}

/**
 * 从 settings.json 文件或 manifest.settings 加载插件设置。
 * 当两者都存在时，settings.json 优先于 manifest.settings。
 * 结果中仅包含白名单中的键。
 */
export async function loadPluginSettings(
  pluginPath: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown> | undefined> {
  // 尝试从插件目录加载 settings.json
  const settingsJsonPath = join(pluginPath, 'settings.json')
  try {
    const content = await readFile(settingsJsonPath, { encoding: 'utf-8' })
    const parsed = jsonParse(content)
    if (isRecord(parsed)) {
      const filtered = parsePluginSettings(parsed)
      if (filtered) {
        logForDebugging(`Loaded settings from settings.json for plugin ${manifest.name}`)
        return filtered
      }
    }
  } catch (e: unknown) {
    // 缺失/无法访问是预期的 - settings.json 是可选的
    if (!isFsInaccessible(e)) {
      logForDebugging(`Failed to parse settings.json for plugin ${manifest.name}: ${e}`, {
        level: 'warn',
      })
    }
  }

  // 回退到 manifest.settings
  if (manifest.settings) {
    const filtered = parsePluginSettings(manifest.settings as Record<string, unknown>)
    if (filtered) {
      logForDebugging(`Loaded settings from manifest for plugin ${manifest.name}`)
      return filtered
    }
  }

  return undefined
}

/**
 * 合并两个 HooksSettings 对象
 */
export function mergeHooksSettings(
  base: HooksSettings | undefined,
  additional: HooksSettings,
): HooksSettings {
  if (!base) {
    return additional
  }

  const merged = { ...base }

  for (const [event, matchers] of Object.entries(additional)) {
    if (!merged[event as keyof HooksSettings]) {
      merged[event as keyof HooksSettings] = matchers
    } else {
      // 合并此事件的匹配器
      merged[event as keyof HooksSettings] = [
        ...(merged[event as keyof HooksSettings] || []),
        ...matchers,
      ]
    }
  }

  return merged
}

/**
 * 两种加载模式共享的发现/策略/合并管道。
 *
 * 解析 enabledPlugins → marketplace 条目，运行企业策略检查，
 * 预加载目录，然后将每个条目分派给完整或仅缓存的逐条目加载器。
 * loadAllPlugins 和 loadAllPluginsCacheOnly 之间唯一的区别是
 * 运行哪个加载器 — 发现和策略是相同的。
 */
export async function loadPluginsFromMarketplaces({ cacheOnly }: { cacheOnly: boolean }): Promise<{
  plugins: LoadedPlugin[]
  errors: PluginError[]
}> {
  const settings = getInitialSettings()
  // 以最低优先级合并 --add-dir 插件；标准设置在冲突时胜出
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(settings.enabledPlugins || {}),
  }
  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  // 过滤为 plugin@marketplace 格式并验证
  const marketplacePluginEntries = Object.entries(enabledPlugins).filter(([key, value]) => {
    // 检查是否为 plugin@marketplace 格式（包括已启用和已禁用的）
    const isValidFormat = PluginIdSchema().safeParse(key).success
    if (!isValidFormat || value === undefined) {
      return false
    }
    // 跳过内置插件 — 由 getBuiltinPlugins() 单独处理
    const { marketplace } = parsePluginIdentifier(key)
    return marketplace !== BUILTIN_MARKETPLACE_NAME
  })

  // 加载已知 marketplace 配置以查找用于策略检查的源。
  // 使用 Safe 变体，这样损坏的配置文件不会导致所有插件
  // 加载崩溃 — 这是只读路径，返回 {} 可以优雅降级。
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()

  // 企业策略的失败关闭守卫：如果策略已配置且我们无法解析
  // marketplace 的源（配置因损坏返回 {}，或条目缺失），我们绝不能
  // 静默跳过策略检查而加载插件。在 Safe 之前，损坏的配置会导致
  // 所有东西崩溃（响亮的失败关闭）。有了 Safe + 无守卫，策略检查
  // 在 undefined marketplaceConfig 时短路，回退路径（getPluginByIdCacheOnly）
  // 会不经检查地加载插件 — 静默的失败开放。此守卫恢复
  // 失败关闭：未知源 + 活跃策略 → 阻止。
  //
  // 允许列表：任何值（包括 []）都是活跃的 — 空允许列表 = 拒绝所有。
  // 阻止列表：空 [] 是语义上的空操作 — 只有非空才算活跃。
  const strictAllowlist = getStrictKnownMarketplaces()
  const blocklist = getBlockedMarketplaces()
  const hasEnterprisePolicy =
    strictAllowlist !== null || (blocklist !== null && blocklist.length > 0)

  // 每个 marketplace 预加载一次目录，而不是为每个插件重新读取
  // known_marketplaces.json + marketplace.json。这是热路径 —
  // 对于 M 个 marketplace 中的 N 个插件，旧的逐插件
  // getPluginByIdCacheOnly() 执行 2N 次配置读取 + N 次目录读取；这里只做 M 次。
  const uniqueMarketplaces = new Set(
    marketplacePluginEntries
      .map(([pluginId]) => parsePluginIdentifier(pluginId).marketplace)
      .filter((m): m is string => !!m),
  )
  const marketplaceCatalogs = new Map<string, Awaited<ReturnType<typeof getMarketplaceCacheOnly>>>()
  await Promise.all(
    [...uniqueMarketplaces].map(async (name) => {
      marketplaceCatalogs.set(name, await getMarketplaceCacheOnly(name))
    }),
  )

  // 一次性查找已安装版本，这样即使 marketplace 条目省略了 `version`
  // 首次 ZIP 缓存检查也能命中。
  const installedPluginsData = getInMemoryInstalledPlugins()

  // 并行加载所有 marketplace 插件以加快启动速度
  const results = await Promise.allSettled(
    marketplacePluginEntries.map(async ([pluginId, enabledValue]) => {
      const { name: pluginName, marketplace: marketplaceName } = parsePluginIdentifier(pluginId)

      // 检查 marketplace 源是否被企业策略允许
      const marketplaceConfig = knownMarketplaces[marketplaceName!]

      // 失败关闭：如果企业策略活跃且我们无法查找 marketplace 源
      // （配置损坏/为空，或条目缺失），阻止而非静默跳过策略检查。
      // 参见上面的 hasEnterprisePolicy 注释了解此守卫防范的
      // 失败开放风险。
      //
      // 这也适用于“过期的 enabledPlugins 条目且无已注册
      // marketplace”的情况，这是一个用户体验权衡：用户会看到策略
      // 错误而非插件未找到。这是可接受的，因为回退路径
      // （getPluginByIdCacheOnly）对 known_marketplaces.json 进行原始
      // 类型转换且无 schema 验证 — 如果某条目损坏到无法通过我们的
      // 验证但原始转换可读，它会未经检查就加载。
      // 不可验证的源 + 活跃策略 → 始终阻止。
      if (!marketplaceConfig && hasEnterprisePolicy) {
        // 我们无法知道不可验证的源是否实际在阻止列表中或不在
        // 允许列表中 — 因此选择与已配置策略匹配的错误变体。
        // 如果允许列表存在，“不在允许列表中”是正确的表述；如果只有
        // 阻止列表存在，“被阻止列表阻止”比显示空的允许源列表
        // 更不易造成误解。
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: strictAllowlist === null,
          allowedSources: (strictAllowlist ?? []).map((s) => formatSourceForDisplay(s)),
        })
        return null
      }

      if (marketplaceConfig && !isSourceAllowedByPolicy(marketplaceConfig.source)) {
        // 检查是被显式阻止还是不在允许列表中，以提供更好的错误上下文
        const isBlocked = isSourceInBlocklist(marketplaceConfig.source)
        const allowlist = getStrictKnownMarketplaces() || []
        errors.push({
          type: 'marketplace-blocked-by-policy',
          source: pluginId,
          plugin: pluginName,
          marketplace: marketplaceName!,
          blockedByBlocklist: isBlocked,
          allowedSources: isBlocked ? [] : allowlist.map((s) => formatSourceForDisplay(s)),
        })
        return null
      }

      // 从预加载的 marketplace 目录查找插件条目（无逐插件 I/O）。
      // 如果目录无法预加载则回退到 getPluginByIdCacheOnly。
      let result: Awaited<ReturnType<typeof getPluginByIdCacheOnly>> = null
      const marketplace = marketplaceCatalogs.get(marketplaceName!)
      if (marketplace && marketplaceConfig) {
        const entry = marketplace.plugins.find((p) => p.name === pluginName)
        if (entry) {
          result = {
            entry,
            marketplaceInstallLocation: marketplaceConfig.installLocation,
          }
        }
      } else {
        result = await getPluginByIdCacheOnly(pluginId)
      }

      if (!result) {
        errors.push({
          type: 'plugin-not-found',
          source: pluginId,
          pluginId: pluginName!,
          marketplace: marketplaceName!,
        })
        return null
      }

      // installed_plugins.json 记录了磁盘上实际缓存的内容
      // （version 用于完整加载器的首次探测，installPath 用于
      // 仅缓存加载器的直接读取）。
      const installEntry = installedPluginsData.plugins[pluginId]?.[0]
      return cacheOnly
        ? loadPluginFromMarketplaceEntryCacheOnly(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.installPath,
          )
        : loadPluginFromMarketplaceEntry(
            result.entry,
            result.marketplaceInstallLocation,
            pluginId,
            enabledValue === true,
            errors,
            installEntry?.version,
          )
    }),
  )

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) {
      plugins.push(result.value)
    } else if (result.status === 'rejected') {
      const err = toError(result.reason)
      logError(err)
      const pluginId = marketplacePluginEntries[i]![0]
      errors.push({
        type: 'generic-error',
        source: pluginId,
        plugin: pluginId.split('@')[0],
        error: err.message,
      })
    }
  }

  return { plugins, errors }
}

/**
 * loadPluginFromMarketplaceEntry 的仅缓存变体。
 *
 * 跳过网络（cachePlugin）和磁盘复制（copyPluginToVersionedCache）。
 * 直接从记录的 installPath 读取；如果缺失，发出
 * 'plugin-cache-miss'。仍然提取 ZIP 缓存的插件（本地，快速）。
 */
export async function loadPluginFromMarketplaceEntryCacheOnly(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installPath: string | undefined,
): Promise<LoadedPlugin | null> {
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // 本地相对路径 — 直接从 marketplace 源目录读取。
    // 跳过 copyPluginToVersionedCache；启动时不需要新副本。
    let marketplaceDir: string
    try {
      marketplaceDir = (await stat(marketplaceInstallLocation)).isDirectory()
        ? marketplaceInstallLocation
        : join(marketplaceInstallLocation, '..')
    } catch {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: marketplaceInstallLocation,
      })
      return null
    }
    pluginPath = join(marketplaceDir, entry.source)
    // finishLoadingPluginFromPath 读取 pluginPath — 其错误处理
    // 会将 ENOENT 作为加载失败暴露，无需在此预检查。
  } else {
    // 外部源（npm/github/url/git-subdir）— 使用记录的 installPath。
    if (!installPath || !(await pathExists(installPath))) {
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: installPath ?? '(not recorded)',
      })
      return null
    }
    pluginPath = installPath
  }

  // Zip 缓存提取 — 在 cacheOnly 模式下仍必须执行（不变量 4）
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(sessionDir, pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'))
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      pluginPath = extractDir
    } catch (error) {
      logForDebugging(`Failed to extract plugin ZIP ${pluginPath}: ${error}`, {
        level: 'error',
      })
      errorsOut.push({
        type: 'plugin-cache-miss',
        source: pluginId,
        plugin: entry.name,
        installPath: pluginPath,
      })
      return null
    }
  }

  // 委派给共享尾部 — 从这里开始与完整加载器相同
  return finishLoadingPluginFromPath(entry, pluginId, enabled, errorsOut, pluginPath)
}

/**
 * 根据源配置从 marketplace 条目加载插件。
 *
 * 处理不同的源类型：
 * - 相对路径：从 marketplace 仓库目录加载
 * - npm/github/url：缓存后从缓存加载
 *
 * @param installedVersion - 来自 installed_plugins.json 的版本，当 marketplace 条目
 *   省略 `version` 时用作版本化缓存查找的首次探测提示。避免仅为发现
 *   安装时已记录的版本而重新克隆外部插件。
 *
 * 返回加载的插件和加载过程中遇到的任何错误。
 * 错误包括缺失的组件文件和 hook 加载失败。
 */
export async function loadPluginFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
  marketplaceInstallLocation: string,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  installedVersion?: string,
): Promise<LoadedPlugin | null> {
  logForDebugging(`Loading plugin ${entry.name} from source: ${jsonStringify(entry.source)}`)
  let pluginPath: string

  if (typeof entry.source === 'string') {
    // 相对路径 - 相对于 marketplace 安装位置解析
    const marketplaceDir = (await stat(marketplaceInstallLocation)).isDirectory()
      ? marketplaceInstallLocation
      : join(marketplaceInstallLocation, '..')
    const sourcePluginPath = join(marketplaceDir, entry.source)

    if (!(await pathExists(sourcePluginPath))) {
      const error = new Error(`Plugin path not found: ${sourcePluginPath}`)
      logForDebugging(`Plugin path not found: ${sourcePluginPath}`, {
        level: 'error',
      })
      logError(error)
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Plugin directory not found at path: ${sourcePluginPath}. Check that the marketplace entry has the correct path.`,
      })
      return null
    }

    // 始终将本地插件复制到版本化缓存
    try {
      // 先尝试从插件目录加载清单以检查版本字段
      const manifestPath = join(sourcePluginPath, '.zy-plugin', 'plugin.json')
      let pluginManifest: PluginManifest | undefined
      try {
        pluginManifest = await loadPluginManifest(manifestPath, entry.name, entry.source)
      } catch {
        // 清单加载失败 - 将回退到提供的版本或 git SHA
      }

      // 按回退顺序计算版本：
      // 1. 插件清单版本，2. Marketplace 条目版本，3. Git SHA，4. 'unknown'
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        pluginManifest,
        marketplaceDir,
        entry.version, // Marketplace 条目版本作为回退
      )

      // 复制到版本化缓存
      pluginPath = await copyPluginToVersionedCache(
        sourcePluginPath,
        pluginId,
        version,
        entry,
        marketplaceDir,
      )

      logForDebugging(`Resolved local plugin ${entry.name} to versioned cache: ${pluginPath}`)
    } catch (error) {
      // 如果复制失败，回退到直接从 marketplace 加载
      const errorMsg = errorMessage(error)
      logForDebugging(
        `Failed to copy plugin ${entry.name} to versioned cache: ${errorMsg}. Using marketplace path.`,
        { level: 'warn' },
      )
      pluginPath = sourcePluginPath
    }
  } else {
    // 外部源（npm、github、url、pip）- 始终使用版本化缓存
    try {
      // 按回退顺序计算版本：
      // 1. 尚无清单，2. installed_plugins.json 版本，
      //    3. Marketplace 条目版本，4. source.sha（固定提交 — 与
      //    克隆后调用 cached.gitCommitSha 看到的完全相同的值），
      //    5. 'unknown' → 按设计跟踪 ref，落入克隆路径。
      const version = await calculatePluginVersion(
        pluginId,
        entry.source,
        undefined,
        undefined,
        installedVersion ?? entry.version,
        'sha' in entry.source ? entry.source.sha : undefined,
      )

      const versionedPath = getVersionedCachePath(pluginId, version)

      // 检查缓存版本 — ZIP 文件（zip 缓存模式）或目录
      const zipPath = getVersionedZipCachePath(pluginId, version)
      if (isPluginZipCacheEnabled() && (await pathExists(zipPath))) {
        logForDebugging(`Using versioned cached plugin ZIP ${entry.name} from ${zipPath}`)
        pluginPath = zipPath
      } else if (await pathExists(versionedPath)) {
        logForDebugging(`Using versioned cached plugin ${entry.name} from ${versionedPath}`)
        pluginPath = versionedPath
      } else {
        // 种子缓存探测（CCR 预烘焙镜像，只读）。种子内容在镜像
        // 构建时冻结 — 无新鲜度问题，“那里有什么”就是镜像构建者
        // 放的。主缓存不在此探测；跟踪 ref 的源落入克隆路径
        // （重新克隆本身就是新鲜度机制）。如果克隆失败，插件
        // 只是在本次会话中禁用 — 下面的 errorsOut.push 会暴露它。
        const seedPath =
          (await probeSeedCache(pluginId, version)) ??
          (version === 'unknown' ? await probeSeedCacheAnyVersion(pluginId) : null)
        if (seedPath) {
          pluginPath = seedPath
          logForDebugging(`Using seed cache for external plugin ${entry.name} at ${seedPath}`)
        } else {
          // 下载到临时位置，然后复制到版本化缓存
          const cached = await cachePlugin(entry.source, {
            manifest: { name: entry.name },
          })

          // 如果克隆前版本是确定性的（source.sha /
          // entry.version / installedVersion），则重用它。克隆后
          // 使用 cached.manifest 重新计算可能返回不同的值
          // — manifest.version（步骤 1）优先于 gitCommitSha（步骤 3）—
          // 这会缓存到例如 "2.0.0/" 而每次热启动
          // 探测 "{sha12}-{hash}/"。不匹配的键 = 永远重新克隆。
          // 仅当克隆前为 'unknown'时才需要重新计算
          // （跟踪 ref，无提示）— 克隆是获知的唯一方式。
          const actualVersion =
            version !== 'unknown'
              ? version
              : await calculatePluginVersion(
                  pluginId,
                  entry.source,
                  cached.manifest,
                  cached.path,
                  installedVersion ?? entry.version,
                  cached.gitCommitSha,
                )

          // 复制到版本化缓存
          // 对于外部源，marketplaceDir 不适用（已下载）
          pluginPath = await copyPluginToVersionedCache(
            cached.path,
            pluginId,
            actualVersion,
            entry,
            undefined,
          )

          // 清理临时路径
          if (cached.path !== pluginPath) {
            await rm(cached.path, { recursive: true, force: true })
          }
        }
      }
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to cache plugin ${entry.name}: ${errorMsg}`, {
        level: 'error',
      })
      logError(toError(error))
      errorsOut.push({
        type: 'generic-error',
        source: pluginId,
        error: `Failed to download/cache plugin ${entry.name}: ${errorMsg}`,
      })
      return null
    }
  }

  // Zip 缓存模式：加载前将 ZIP 提取到会话临时目录
  if (isPluginZipCacheEnabled() && pluginPath.endsWith('.zip')) {
    const sessionDir = await getSessionPluginCachePath()
    const extractDir = join(sessionDir, pluginId.replace(/[^a-zA-Z0-9@\-_]/g, '-'))
    try {
      await extractZipToDirectory(pluginPath, extractDir)
      logForDebugging(`Extracted plugin ZIP to session dir: ${extractDir}`)
      pluginPath = extractDir
    } catch (error) {
      // 损坏的 ZIP：删除它以便下次安装尝试重新创建
      logForDebugging(`Failed to extract plugin ZIP ${pluginPath}, deleting corrupt file: ${error}`)
      await rm(pluginPath, { force: true }).catch(() => {})
      throw error
    }
  }

  return finishLoadingPluginFromPath(entry, pluginId, enabled, errorsOut, pluginPath)
}
