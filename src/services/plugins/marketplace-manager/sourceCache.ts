/**
 * ZY Code 插件的 Marketplace 管理器
 *
 * 本模块提供以下功能：
 * - 管理已知的 marketplace 源（URL、GitHub 仓库、npm 包、本地文件）
 * - 本地缓存 marketplace 清单以供离线访问
 * - 从 marketplace 条目安装插件
 * - 跟踪和更新 marketplace 配置
 *
 * 本模块管理的文件结构：
 * ~/.zy/
 *   └── plugins/
 *       ├── known_marketplaces.json    # 所有已知 marketplace 的配置
 *       └── marketplaces/              # marketplace 数据的缓存目录
 *           ├── my-marketplace.json    # 从 URL 源缓存的 marketplace
 *           └── github-marketplace/    # 从 GitHub 源克隆的仓库
 *               └── .zy-plugin/
 *                   └── marketplace.json
 */

import { writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  ConfigParseError,
  errorMessage,
  getErrnoCode,
  isENOENT,
  toError,
} from '../../../utils/errors.js'
import { getFsImplementation } from '../../../utils/fsOperations.js'
import { logError } from '../../../utils/log.js'
import { getSettingsForSource, updateSettingsForSource } from '../../settings/settings.js'
import type { SettingsJson } from '../../settings/types.js'
import { jsonParse, jsonStringify } from '../../../utils/slowOperations.js'
import { markPluginVersionOrphaned } from '../cacheUtils.js'
import { removeAllPluginsForMarketplace } from '../installedPluginsManager.js'
import {
  extractHostFromSource,
  formatSourceForDisplay,
  getHostPatternsFromAllowlist,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from '../marketplaceHelpers.js'
import { deletePluginDataDir } from '../pluginDirectories.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import { deletePluginOptions } from '../pluginOptionsStorage.js'
import {
  isLocalMarketplaceSource,
  type MarketplaceSource,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  PluginMarketplaceSchema,
  validateOfficialNameSource,
} from '../schemas.js'
import {
  KnownMarketplacesConfig,
  LoadedPluginMarketplace,
  getKnownMarketplacesFile,
  getMarketplacesCacheDir,
  isGitHubSshLikelyConfigured,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
  seedDirFor,
} from './configuration.js'
import {
  MarketplaceProgressCallback,
  cacheMarketplaceFromGit,
  cacheMarketplaceFromUrl,
  getCachePathForSource,
  parseFileWithSchema,
  safeCallProgress,
} from './gitTransport.js'
/**
 * 从源加载并缓存 marketplace
 *
 * 处理不同的源类型：
 * - URL：直接下载 marketplace.json
 * - GitHub：克隆仓库并查找 .zy-plugin/marketplace.json
 * - Git：从 git URL 克隆仓库
 * - NPM：（尚未实现）将从 npm 包获取
 * - File：从本地文件系统读取
 *
 * 加载后验证 marketplace schema 并重命名缓存
 * 以匹配清单中 marketplace 的实际名称。
 *
 * 缓存结构：
 * ~/.zy/plugins/marketplaces/
 *   ├── official-marketplace.json     # 来自 URL 源
 *   ├── github-marketplace/          # 来自 GitHub/Git 源
 *   │   └── .zy-plugin/
 *   │       └── marketplace.json
 *   └── local-marketplace.json       # 来自文件源
 *
 * @param source - 要从中加载的 marketplace 源
 * @param onProgress - 可选的报告进度的回调
 * @returns 包含已验证的 marketplace 及其缓存路径的对象
 * @throws 如果 marketplace 文件未找到或验证失败则抛出异常
 */
export async function loadAndCacheMarketplace(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<LoadedPluginMarketplace> {
  const fs = getFsImplementation()
  const cacheDir = getMarketplacesCacheDir()

  // 确保缓存目录存在
  await fs.mkdir(cacheDir)

  let temporaryCachePath: string
  let marketplacePath: string
  let cleanupNeeded = false

  // 为缓存路径生成临时名称
  const tempName = getCachePathForSource(source)

  try {
    switch (source.source) {
      case 'url': {
        // marketplace.json 的直接 URL
        temporaryCachePath = join(cacheDir, `${tempName}.json`)
        cleanupNeeded = true
        await cacheMarketplaceFromUrl(source.url, temporaryCachePath, source.headers, onProgress)
        marketplacePath = temporaryCachePath
        break
      }

      case 'github': {
        // 智能 SSH/HTTPS 选择：在尝试前检查 SSH 是否已配置
        // 这避免了当 SSH 未配置时等待超时
        const sshUrl = `git@github.com:${source.repo}.git`
        const httpsUrl = `https://github.com/${source.repo}.git`
        temporaryCachePath = join(cacheDir, tempName)
        cleanupNeeded = true

        let lastError: Error | null = null

        // 快速检查 SSH 是否可能工作
        const sshConfigured = await isGitHubSshLikelyConfigured()

        if (sshConfigured) {
          // SSH 看起来没问题，先尝试
          safeCallProgress(onProgress, `Cloning via SSH: ${sshUrl}`)
          try {
            await cacheMarketplaceFromGit(
              sshUrl,
              temporaryCachePath,
              source.ref,
              source.sparsePaths,
              onProgress,
            )
          } catch (err) {
            lastError = toError(err)

            // 记录 SSH 失败以便监控
            logError(lastError)

            // SSH 尽管已配置但仍失败，尝试 HTTPS 回退
            safeCallProgress(onProgress, `SSH clone failed, retrying with HTTPS: ${httpsUrl}`)

            logForDebugging(
              `SSH clone failed for ${source.repo} despite SSH being configured, falling back to HTTPS`,
              { level: 'info' },
            )

            // 清理失败的 SSH 尝试（如果创建了任何内容）
            await fs.rm(temporaryCachePath, { recursive: true, force: true })

            // 尝试 HTTPS
            try {
              await cacheMarketplaceFromGit(
                httpsUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
              )
              lastError = null // 成功！
            } catch (httpsErr) {
              // HTTPS 也失败了 - 使用 HTTPS 错误作为最终错误
              lastError = toError(httpsErr)

              // 记录 HTTPS 失败以便监控（SSH 和 HTTPS 都失败了）
              logError(lastError)
            }
          }
        } else {
          // SSH 未配置，直接使用 HTTPS
          safeCallProgress(onProgress, `SSH not configured, cloning via HTTPS: ${httpsUrl}`)

          logForDebugging(`SSH not configured for GitHub, using HTTPS for ${source.repo}`, {
            level: 'info',
          })

          try {
            await cacheMarketplaceFromGit(
              httpsUrl,
              temporaryCachePath,
              source.ref,
              source.sparsePaths,
              onProgress,
            )
          } catch (err) {
            lastError = toError(err)

            // 对于任何 HTTPS 失败始终尝试 SSH 作为回退
            // 记录 HTTPS 失败以便监控
            logError(lastError)

            // HTTPS 失败，尝试 SSH 作为回退
            safeCallProgress(onProgress, `HTTPS clone failed, retrying with SSH: ${sshUrl}`)

            logForDebugging(
              `HTTPS clone failed for ${source.repo} (${lastError.message}), falling back to SSH`,
              { level: 'info' },
            )

            // 清理失败的 HTTPS 尝试（如果创建了任何内容）
            await fs.rm(temporaryCachePath, { recursive: true, force: true })

            // 尝试 SSH
            try {
              await cacheMarketplaceFromGit(
                sshUrl,
                temporaryCachePath,
                source.ref,
                source.sparsePaths,
                onProgress,
              )
              lastError = null // 成功！
            } catch (sshErr) {
              // SSH 也失败了 - 使用 SSH 错误作为最终错误
              lastError = toError(sshErr)

              // 记录 SSH 失败以便监控 (both HTTPS and SSH failed)
              logError(lastError)
            }
          }
        }

        // 如果我们仍然有错误，抛出它
        if (lastError) {
          throw lastError
        }

        marketplacePath = join(temporaryCachePath, source.path || '.zy-plugin/marketplace.json')
        break
      }

      case 'git': {
        temporaryCachePath = join(cacheDir, tempName)
        cleanupNeeded = true
        await cacheMarketplaceFromGit(
          source.url,
          temporaryCachePath,
          source.ref,
          source.sparsePaths,
          onProgress,
        )
        marketplacePath = join(temporaryCachePath, source.path || '.zy-plugin/marketplace.json')
        break
      }

      case 'npm': {
        // TODO: 实现 npm 包支持
        throw new Error('NPM marketplace sources not yet implemented')
      }

      case 'file': {
        // For local files, resolve paths relative to marketplace root directory
        // File sources point to .zy-plugin/marketplace.json, so the marketplace
        // root is two directories up (parent of .zy-plugin/)
        // Resolve to absolute so error messages show the actual path checked
        // (legacy known_marketplaces.json entries may have relative paths)
        const absPath = resolve(source.path)
        marketplacePath = absPath
        temporaryCachePath = dirname(dirname(absPath))
        cleanupNeeded = false
        break
      }

      case 'directory': {
        // For directories, look for .zy-plugin/marketplace.json
        // Resolve to absolute so error messages show the actual path checked
        // (legacy known_marketplaces.json entries may have relative paths)
        const absPath = resolve(source.path)
        marketplacePath = join(absPath, '.zy-plugin', 'marketplace.json')
        temporaryCachePath = absPath
        cleanupNeeded = false
        break
      }

      case 'settings': {
        // Inline manifest from settings.json — no fetch. Synthesize the
        // marketplace.json on disk so getMarketplaceCacheOnly reads it
        // like any other source. The plugins array already passed
        // PluginMarketplaceEntrySchema validation when settings were parsed;
        // the post-switch parseFileWithSchema re-validates the full
        // PluginMarketplaceSchema (catches schema drift between the two).
        //
        // Writing to source.name up front means the rename below is a no-op
        // (temporaryCachePath === finalCachePath). known_marketplaces.json
        // stores this source object including the plugins array, so
        // diffMarketplaces detects settings edits via isEqual — no special
        // dirty-tracking needed.
        temporaryCachePath = join(cacheDir, source.name)
        marketplacePath = join(temporaryCachePath, '.zy-plugin', 'marketplace.json')
        cleanupNeeded = false
        await fs.mkdir(dirname(marketplacePath))
        // No `satisfies PluginMarketplace` here: source.plugins is the narrow
        // SettingsMarketplacePlugin type (no strict/.default(), no manifest
        // fields). The parseFileWithSchema(PluginMarketplaceSchema()) call
        // below widens and validates — that's the real check.
        await writeFile(
          marketplacePath,
          jsonStringify(
            {
              name: source.name,
              owner: source.owner ?? { name: 'settings' },
              plugins: source.plugins,
            },
            null,
            2,
          ),
        )
        break
      }

      default:
        throw new Error(`Unsupported marketplace source type`)
    }

    // 加载并验证 marketplace
    logForDebugging(`Reading marketplace from ${marketplacePath}`)
    let marketplace: PluginMarketplace
    try {
      marketplace = await parseFileWithSchema(marketplacePath, PluginMarketplaceSchema())
    } catch (e) {
      if (isENOENT(e)) {
        throw new Error(`Marketplace file not found at ${marketplacePath}`)
      }
      throw new Error(`Failed to parse marketplace file at ${marketplacePath}: ${errorMessage(e)}`)
    }

    // 现在重命名缓存路径以使用 marketplace 的实际名称
    const finalCachePath = join(cacheDir, marketplace.name)
    // Defense-in-depth: the schema rejects path separators, .., and . in marketplace.name,
    // but verify the computed path is a strict subdirectory of cacheDir before fs.rm.
    // A malicious marketplace.json with a crafted name must never cause us to rm outside
    // cacheDir, nor rm cacheDir itself (e.g. name "." → join normalizes to cacheDir).
    const resolvedFinal = resolve(finalCachePath)
    const resolvedCacheDir = resolve(cacheDir)
    if (!resolvedFinal.startsWith(resolvedCacheDir + sep)) {
      throw new Error(
        `Marketplace name '${marketplace.name}' resolves to a path outside the cache directory`,
      )
    }
    // 如果是本地文件或目录，或已有正确名称则不重命名
    if (temporaryCachePath !== finalCachePath && !isLocalMarketplaceSource(source)) {
      try {
        // 如果目标已存在则删除，然后重命名
        try {
          onProgress?.('Cleaning up old marketplace cache…')
        } catch (callbackError) {
          logForDebugging(`Progress callback error: ${errorMessage(callbackError)}`, {
            level: 'warn',
          })
        }
        await fs.rm(finalCachePath, { recursive: true, force: true })
        // 将临时缓存重命名为最终名称
        await fs.rename(temporaryCachePath, finalCachePath)
        temporaryCachePath = finalCachePath
        cleanupNeeded = false // 成功重命名，无需清理
      } catch (error) {
        const errorMsg = errorMessage(error)
        throw new Error(
          `Failed to finalize marketplace cache. Please manually delete the directory at ${finalCachePath} if it exists and try again.\n\nTechnical details: ${errorMsg}`,
        )
      }
    }

    return { marketplace, cachePath: temporaryCachePath }
  } catch (error) {
    // 出错时清理任何临时文件/目录
    if (cleanupNeeded && temporaryCachePath! && !isLocalMarketplaceSource(source)) {
      try {
        await fs.rm(temporaryCachePath!, { recursive: true, force: true })
      } catch (cleanupError) {
        logForDebugging(
          `Warning: Failed to clean up temporary marketplace cache at ${temporaryCachePath}: ${errorMessage(cleanupError)}`,
          { level: 'warn' },
        )
      }
    }
    throw error
  }
}

/**
 * 将 marketplace 源添加到已知 marketplace 中
 *
 * 获取、验证 marketplace 并本地缓存。
 * 配置保存到 ~/.zy/plugins/known_marketplaces.json。
 *
 * @param source - 表示 marketplace 源的 MarketplaceSource 对象。
 *                 调用者应将用户输入解析为 MarketplaceSource 格式
 *                 （参见 AddMarketplace.parseMarketplaceInput 处理 "owner/repo" 等简写）。
 * @param onProgress - 可选的用于 marketplace 安装期间进度更新的回调
 * @throws 如果源格式无效或 marketplace 无法加载则抛出异常
 */
export async function addMarketplaceSource(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback,
): Promise<{
  name: string
  alreadyMaterialized: boolean
  resolvedSource: MarketplaceSource
}> {
  // 将相对目录/文件路径解析为绝对路径，使状态不依赖 cwd
  let resolvedSource = source
  if (isLocalMarketplaceSource(source) && !isAbsolute(source.path)) {
    resolvedSource = { ...source, path: resolve(source.path) }
  }

  // 先检查策略，在任何网络/文件系统操作之前
  // 这可以防止在源被阻止时进行下载/克隆
  if (!isSourceAllowedByPolicy(resolvedSource)) {
    // 检查是被显式阻止还是不在允许列表中，以提供更好的错误消息
    if (isSourceInBlocklist(resolvedSource)) {
      throw new Error(
        `Marketplace source '${formatSourceForDisplay(resolvedSource)}' is blocked by enterprise policy.`,
      )
    }
    // 不在允许列表中 - 构建有帮助的错误消息
    const allowlist = getStrictKnownMarketplaces() || []
    const hostPatterns = getHostPatternsFromAllowlist()
    const sourceHost = extractHostFromSource(resolvedSource)

    let errorMessage = `Marketplace source '${formatSourceForDisplay(resolvedSource)}'`
    if (sourceHost) {
      errorMessage += ` (${sourceHost})`
    }
    errorMessage += ' is blocked by enterprise policy.'

    if (allowlist.length > 0) {
      errorMessage += ` Allowed sources: ${allowlist.map((s) => formatSourceForDisplay(s)).join(', ')}`
    } else {
      errorMessage += ' No external marketplaces are allowed.'
    }

    // 如果源是 github 简写且有 hostPatterns，建议使用完整 URL
    if (resolvedSource.source === 'github' && hostPatterns.length > 0) {
      errorMessage +=
        `\n\nTip: The shorthand "${resolvedSource.repo}" assumes github.com. ` +
        `For internal GitHub Enterprise, use the full URL:\n` +
        `  git@your-github-host.com:${resolvedSource.repo}.git`
    }

    throw new Error(errorMessage)
  }

  // 源幂等性：如果此确切源已存在，跳过克隆
  const existingConfig = await loadKnownMarketplacesConfig()
  for (const [existingName, existingEntry] of Object.entries(existingConfig)) {
    if (isEqual(existingEntry.source, resolvedSource)) {
      logForDebugging(`Source already materialized as '${existingName}', skipping clone`)
      return { name: existingName, alreadyMaterialized: true, resolvedSource }
    }
  }

  // 加载并缓存 marketplace 以验证它并获取其名称
  const { marketplace, cachePath } = await loadAndCacheMarketplace(resolvedSource, onProgress)

  // 验证保留名称来自官方源
  const sourceValidationError = validateOfficialNameSource(marketplace.name, resolvedSource)
  if (sourceValidationError) {
    throw new Error(sourceValidationError)
  }

  // 与不同源的名称冲突：覆写（settings 意图胜出）。
  // 种子管理的条目是管理员控制的，不能被覆写。
  // 克隆后重新读取配置（可能需要一段时间；另一个进程可能已写入）。
  const config = await loadKnownMarketplacesConfig()
  const oldEntry = config[marketplace.name]
  if (oldEntry) {
    const seedDir = seedDirFor(oldEntry.installLocation)
    if (seedDir) {
      throw new Error(
        `Marketplace '${marketplace.name}' is seed-managed (${seedDir}). ` +
          `To use a different source, ask your admin to update the seed, ` +
          `or use a different marketplace name.`,
      )
    }
    logForDebugging(`Marketplace '${marketplace.name}' exists with different source — overwriting`)
    // Clean up the old cache if it's not a user-owned local path AND it
    // actually differs from the new cachePath. loadAndCacheMarketplace writes
    // to cachePath BEFORE we get here — rm-ing the same dir deletes the fresh
    // write. Settings sources always land on the same dir (name → path);
    // git sources hit this latently when the source repo changes but the
    // fetched marketplace.json declares the same name. Only rm when locations
    // genuinely differ (the only case where there's a stale dir to clean).
    //
    // Defensively validate the stored path before rm: a corrupted
    // installLocation (gh-32793, gh-32661) could point at the user's project
    // dir. If it's outside the cache dir, skip cleanup — the stale dir (if
    // any) is harmless, and blocking the re-add would prevent the user from
    // fixing the corruption.
    if (!isLocalMarketplaceSource(oldEntry.source)) {
      const cacheDir = resolve(getMarketplacesCacheDir())
      const resolvedOld = resolve(oldEntry.installLocation)
      const resolvedNew = resolve(cachePath)
      if (resolvedOld === resolvedNew) {
        // Same dir — loadAndCacheMarketplace already overwrote in place.
        // Nothing to clean.
      } else if (resolvedOld === cacheDir || resolvedOld.startsWith(cacheDir + sep)) {
        const fs = getFsImplementation()
        await fs.rm(oldEntry.installLocation, { recursive: true, force: true })
      } else {
        logForDebugging(
          `Skipping cleanup of old installLocation (${oldEntry.installLocation}) — ` +
            `outside ${cacheDir}. The path is corrupted; leaving it alone and ` +
            `overwriting the config entry.`,
          { level: 'warn' },
        )
      }
    }
  }

  // 使用 marketplace 的实际名称更新配置
  config[marketplace.name] = {
    source: resolvedSource,
    installLocation: cachePath,
    lastUpdated: new Date().toISOString(),
  }
  await saveKnownMarketplacesConfig(config)

  logForDebugging(`Added marketplace source: ${marketplace.name}`)

  return { name: marketplace.name, alreadyMaterialized: false, resolvedSource }
}

/**
 * 从已知 marketplace 中删除 marketplace 源
 *
 * 删除 marketplace 配置并清理缓存文件。
 * 删除目录缓存（用于 git 源）和文件缓存（用于 URL 源）。
 * 还从 settings.json（extraKnownMarketplaces）中清理 marketplace
 * 并从 enabledPlugins 中删除相关插件条目。
 *
 * @param name - 要删除的 marketplace 名称
 * @throws 如果未找到给定名称的 marketplace 则抛出异常
 */
export async function removeMarketplaceSource(name: string): Promise<void> {
  const config = await loadKnownMarketplacesConfig()

  if (!config[name]) {
    throw new Error(`Marketplace '${name}' not found`)
  }

  // 种子注册的 marketplace 是管理员烘焙到容器中的 — 删除
  // 它们是类别错误。它们无论如何会在下次启动时复活。
  // 引导用户执行正确的操作。
  const entry = config[name]
  const seedDir = seedDirFor(entry.installLocation)
  if (seedDir) {
    throw new Error(
      `Marketplace '${name}' is registered from the read-only seed directory ` +
        `(${seedDir}) and will be re-registered on next startup. ` +
        `To stop using its plugins: zy plugin disable <plugin>@${name}`,
    )
  }

  // 从配置中删除
  delete config[name]
  await saveKnownMarketplacesConfig(config)

  // 清理缓存文件（目录和 JSON 格式）
  const fs = getFsImplementation()
  const cacheDir = getMarketplacesCacheDir()
  const cachePath = join(cacheDir, name)
  await fs.rm(cachePath, { recursive: true, force: true })
  const jsonCachePath = join(cacheDir, `${name}.json`)
  await fs.rm(jsonCachePath, { force: true })

  // 清理 settings.json - 从 extraKnownMarketplaces 中删除 marketplace
  // 并从 enabledPlugins 中删除相关插件条目

  // 检查每个可编辑的 settings 源
  const editableSources: Array<'userSettings' | 'projectSettings' | 'localSettings'> = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]

  for (const source of editableSources) {
    const settings = getSettingsForSource(source)
    if (!settings) {
      continue
    }

    let needsUpdate = false
    const updates: {
      extraKnownMarketplaces?: typeof settings.extraKnownMarketplaces
      enabledPlugins?: typeof settings.enabledPlugins
    } = {}

    // 如果存在则从 extraKnownMarketplaces 中删除
    if (settings.extraKnownMarketplaces?.[name]) {
      const updatedMarketplaces: Partial<SettingsJson['extraKnownMarketplaces']> = {
        ...settings.extraKnownMarketplaces,
      }
      // 使用 undefined 值（而非 delete）来通过 mergeWith 信号键删除
      updatedMarketplaces[name] = undefined
      updates.extraKnownMarketplaces = updatedMarketplaces as SettingsJson['extraKnownMarketplaces']
      needsUpdate = true
    }

    // 从 enabledPlugins 中删除相关插件（格式："plugin@marketplace"）
    if (settings.enabledPlugins) {
      const marketplaceSuffix = `@${name}`
      const updatedPlugins = { ...settings.enabledPlugins }
      let removedPlugins = false

      for (const pluginId in updatedPlugins) {
        if (pluginId.endsWith(marketplaceSuffix)) {
          updatedPlugins[pluginId] = undefined
          removedPlugins = true
        }
      }

      if (removedPlugins) {
        updates.enabledPlugins = updatedPlugins
        needsUpdate = true
      }
    }

    // 如果进行了更改则更新 settings
    if (needsUpdate) {
      const result = updateSettingsForSource(source, updates)
      if (result.error) {
        logError(result.error)
        logForDebugging(
          `Failed to clean up marketplace '${name}' from ${source} settings: ${result.error.message}`,
        )
      } else {
        logForDebugging(`Cleaned up marketplace '${name}' from ${source} settings`)
      }
    }
  }

  // 从 installed_plugins.json 中删除插件并标记孤立路径。
  // 同时清除它们存储的选项/密钥 — marketplace 删除后
  // 零安装保留，与 uninstallPluginOp 的“最后一个作用域消失”
  // 条件相同。
  const { orphanedPaths, removedPluginIds } = removeAllPluginsForMarketplace(name)
  for (const installPath of orphanedPaths) {
    await markPluginVersionOrphaned(installPath)
  }
  for (const pluginId of removedPluginIds) {
    deletePluginOptions(pluginId)
    await deletePluginDataDir(pluginId)
  }

  logForDebugging(`Removed marketplace source: ${name}`)
}

/**
 * 从磁盘读取缓存的 marketplace 而不更新它
 *
 * @param installLocation - 缓存的 marketplace 的路径
 * @returns marketplace 对象
 * @throws 如果 marketplace 文件未找到或无效则抛出异常
 */
export async function readCachedMarketplace(installLocation: string): Promise<PluginMarketplace> {
  // 对于 git 源目录，清单位于 .zy-plugin/marketplace.json。
  // 对于 url/file/directory 源，它就是 installLocation 本身。
  // 先尝试嵌套路径；当它是普通文件（ENOTDIR）
  // 或嵌套文件简单缺失（ENOENT）时回退到 installLocation。
  const nestedPath = join(installLocation, '.zy-plugin', 'marketplace.json')
  try {
    return await parseFileWithSchema(nestedPath, PluginMarketplaceSchema())
  } catch (e) {
    if (e instanceof ConfigParseError) {
      throw e
    }
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw e
    }
  }
  return await parseFileWithSchema(installLocation, PluginMarketplaceSchema())
}

/**
 * 仅从缓存按名称获取特定的 marketplace（无网络）。
 * 如果缓存缺失或损坏则返回 null。
 * 用于不应阻塞在网络上的启动路径。
 */
export async function getMarketplaceCacheOnly(name: string): Promise<PluginMarketplace | null> {
  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, { encoding: 'utf-8' })
    const config = jsonParse(content) as KnownMarketplacesConfig
    const entry = config[name]

    if (!entry) {
      return null
    }

    return await readCachedMarketplace(entry.installLocation)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    logForDebugging(`Failed to read cached marketplace ${name}: ${errorMessage(error)}`, {
      level: 'warn',
    })
    return null
  }
}

/**
 * 按名称获取特定的 marketplace
 *
 * 首先尝试从缓存读取。仅在以下情况从源获取：
 * - 不存在缓存版本
 * - 缓存无效/损坏
 *
 * 这避免了每次访问时不必要的网络/git 操作。
 * 使用 refreshMarketplace() 来显式从源更新。
 *
 * @param name - 要获取的 marketplace 名称
 * @returns marketplace 对象或如果未找到/失败则返回 null
 */
export const getMarketplace = memoize(async (name: string): Promise<PluginMarketplace> => {
  const config = await loadKnownMarketplacesConfig()
  const entry = config[name]

  if (!entry) {
    throw new Error(
      `Marketplace '${name}' not found in configuration. Available marketplaces: ${Object.keys(config).join(', ')}`,
    )
  }

  // 旧版条目（#19708 之前）可能在全局配置中有相对路径。
  // 这些在写入它们的项目之外没有意义 — 相对于
  // process.cwd() 解析会产生错误的路径。给出可操作的指导
  // 而不是误导性的 ENOENT。
  if (isLocalMarketplaceSource(entry.source) && !isAbsolute(entry.source.path)) {
    throw new Error(
      `Marketplace "${name}" has a relative source path (${entry.source.path}) ` +
        `in known_marketplaces.json — this is stale state from an older ` +
        `ZY Code version. Run 'zy marketplace remove ${name}' and ` +
        `re-add it from the original project directory.`,
    )
  }

  // 尝试从磁盘缓存读取
  try {
    return await readCachedMarketplace(entry.installLocation)
  } catch (error) {
    // 在重新获取前记录缓存损坏
    logForDebugging(
      `Cache corrupted or missing for marketplace ${name}, re-fetching from source: ${errorMessage(error)}`,
      {
        level: 'warn',
      },
    )
  }

  // 缓存不存在或无效，从源获取
  let marketplace: PluginMarketplace
  try {
    ;({ marketplace } = await loadAndCacheMarketplace(entry.source))
  } catch (error) {
    throw new Error(
      `Failed to load marketplace "${name}" from source (${entry.source.source}): ${errorMessage(error)}`,
    )
  }

  // 仅在实际获取时更新 lastUpdated
  config[name]!.lastUpdated = new Date().toISOString()
  await saveKnownMarketplacesConfig(config)

  return marketplace
})

/**
 * 仅从缓存按 ID 获取插件（无网络调用）。
 * 如果 marketplace 缓存缺失或损坏则返回 null。
 * 用于不应阻塞在网络上的启动路径。
 *
 * @param pluginId - 插件 ID，格式为 "name@marketplace"
 * @returns 插件条目或如果未找到/缓存缺失则返回 null
 */
export async function getPluginByIdCacheOnly(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
} | null> {
  const { name: pluginName, marketplace: marketplaceName } = parsePluginIdentifier(pluginId)
  if (!pluginName || !marketplaceName) {
    return null
  }

  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, { encoding: 'utf-8' })
    const config = jsonParse(content) as KnownMarketplacesConfig
    const marketplaceConfig = config[marketplaceName]

    if (!marketplaceConfig) {
      return null
    }

    const marketplace = await getMarketplaceCacheOnly(marketplaceName)
    if (!marketplace) {
      return null
    }

    const plugin = marketplace.plugins.find((p) => p.name === pluginName)
    if (!plugin) {
      return null
    }

    return {
      entry: plugin,
      marketplaceInstallLocation: marketplaceConfig.installLocation,
    }
  } catch {
    return null
  }
}

/**
 * 从特定 marketplace 按 ID 获取插件
 *
 * 首先尝试仅缓存查找。如果缓存缺失/损坏，
 * 回退到从源获取。
 *
 * @param pluginId - 插件 ID，格式为 "name@marketplace"
 * @returns 插件条目或如果未找到则返回 null
 */
export async function getPluginById(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
} | null> {
  // 先尝试仅缓存（快速路径）
  const cached = await getPluginByIdCacheOnly(pluginId)
  if (cached) {
    return cached
  }

  // 缓存未命中 - 尝试从源获取
  const { name: pluginName, marketplace: marketplaceName } = parsePluginIdentifier(pluginId)
  if (!pluginName || !marketplaceName) {
    return null
  }

  try {
    const config = await loadKnownMarketplacesConfig()
    const marketplaceConfig = config[marketplaceName]
    if (!marketplaceConfig) {
      return null
    }

    const marketplace = await getMarketplace(marketplaceName)
    const plugin = marketplace.plugins.find((p) => p.name === pluginName)

    if (!plugin) {
      return null
    }

    return {
      entry: plugin,
      marketplaceInstallLocation: marketplaceConfig.installLocation,
    }
  } catch (error) {
    logForDebugging(`Could not find plugin ${pluginId}: ${errorMessage(error)}`, { level: 'debug' })
    return null
  }
}
