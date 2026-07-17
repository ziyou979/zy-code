import { resolve, sep } from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { getSettingsForSource } from '../../settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from '../officialMarketplaceGcs.js'
import { isLocalMarketplaceSource } from '../schemas.js'
import {
  getMarketplaceDeclaringSource,
  getMarketplacesCacheDir,
  isGitHubSshLikelyConfigured,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
  saveMarketplaceToSettings,
  seedDirFor,
} from './configuration.js'
import {
  MarketplaceProgressCallback,
  cacheMarketplaceFromGit,
  cacheMarketplaceFromUrl,
  redactUrlCredentials,
  safeCallProgress,
} from './gitTransport.js'
import { getMarketplace, loadAndCacheMarketplace, readCachedMarketplace } from './sourceCache.js'
/**
 * 刷新所有 marketplace 缓存
 *
 * 从其源更新所有已配置的 marketplace。
 * 即使某些 marketplace 失败也继续刷新。
 * 为成功的刷新更新 lastUpdated 时间戳。
 *
 * 这对以下情况很有用：
 * - 定期更新以获取新插件
 * - 网络连接恢复后同步
 * - 在浏览前确保缓存是最新的
 *
 * @returns 当所有刷新尝试完成时解析的 Promise
 */
export async function refreshAllMarketplaces(): Promise<void> {
  const config = await loadKnownMarketplacesConfig()

  for (const [name, entry] of Object.entries(config)) {
    // Seed-managed marketplaces are controlled by the seed image — refreshing
    // them is pointless (registerSeedMarketplaces overwrites on next startup).
    if (seedDirFor(entry.installLocation)) {
      logForDebugging(`Skipping seed-managed marketplace '${name}' in bulk refresh`)
      continue
    }
    // settings-sourced marketplaces have no upstream — see refreshMarketplace.
    if (entry.source.source === 'settings') {
      continue
    }
    // inc-5046: same GCS intercept as refreshMarketplace() — bulk update
    // hits this path on `zy plugin marketplace update` (no name arg).
    if (name === OFFICIAL_MARKETPLACE_NAME) {
      const sha = await fetchOfficialMarketplaceFromGcs(
        entry.installLocation,
        getMarketplacesCacheDir(),
      )
      if (sha !== null) {
        config[name]!.lastUpdated = new Date().toISOString()
        continue
      }
      if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_plugin_official_mkt_git_fallback', true)) {
        logForDebugging(
          `Skipping official marketplace bulk refresh: GCS failed, git fallback disabled`,
        )
        continue
      }
      // fall through to git
    }
    try {
      const { cachePath } = await loadAndCacheMarketplace(entry.source)
      config[name]!.lastUpdated = new Date().toISOString()
      config[name]!.installLocation = cachePath
    } catch (error) {
      logForDebugging(`Failed to refresh marketplace ${name}: ${errorMessage(error)}`, {
        level: 'error',
      })
    }
  }

  await saveKnownMarketplacesConfig(config)
}

/**
 * 刷新单个 marketplace 缓存
 *
 * 通过就地更新从其源更新特定的 marketplace。
 * 对于 git 源，在现有目录中运行 git pull。
 * 对于 URL 源，重新下载到现有文件。
 * 清除记忆化缓存并更新 lastUpdated 时间戳。
 *
 * @param name - 要刷新的 marketplace 名称
 * @param onProgress - 可选的报告进度的回调
 * @throws 如果 marketplace 未找到或刷新失败则抛出异常
 */
export async function refreshMarketplace(
  name: string,
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  const config = await loadKnownMarketplacesConfig()
  const entry = config[name]

  if (!entry) {
    throw new Error(
      `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
    )
  }

  // 清除此特定 marketplace 的记忆化缓存
  getMarketplace.cache?.delete?.(name)

  // settings-sourced marketplaces have no upstream to pull. Edits to the
  // inline plugins array surface as sourceChanged in the reconciler, which
  // re-materializes via addMarketplaceSource — refresh is not the vehicle.
  if (entry.source.source === 'settings') {
    logForDebugging(`Skipping refresh for settings-sourced marketplace '${name}' — no upstream`)
    return
  }

  try {
    // For updates, use the existing installLocation directly (in-place update)
    const installLocation = entry.installLocation
    const source = entry.source

    // Seed-managed marketplaces are controlled by the seed image. Refreshing
    // would be pointless — registerSeedMarketplaces() overwrites installLocation
    // back to seed on next startup. Error with guidance instead.
    const seedDir = seedDirFor(installLocation)
    if (seedDir) {
      throw new Error(
        `Marketplace '${name}' is seed-managed (${seedDir}) and its content is ` +
          `controlled by the seed image. To update: ask your admin to update the seed.`,
      )
    }

    // For remote sources (github/git/url), installLocation must be inside the
    // marketplaces cache dir. A corrupted value (gh-32793, gh-32661 — e.g.
    // Windows path read on WSL, literal tilde, manual edit) can point at the
    // user's project. cacheMarketplaceFromGit would then run git ops with that
    // cwd (git walks up to the user's .git) and fs.rm it on pull failure.
    // Refuse instead of auto-fixing so the user knows their state is corrupted.
    if (!isLocalMarketplaceSource(source)) {
      const cacheDir = resolve(getMarketplacesCacheDir())
      const resolvedLoc = resolve(installLocation)
      if (resolvedLoc !== cacheDir && !resolvedLoc.startsWith(cacheDir + sep)) {
        throw new Error(
          `Marketplace '${name}' has a corrupted installLocation ` +
            `(${installLocation}) — expected a path inside ${cacheDir}. ` +
            `This can happen after cross-platform path writes or manual edits ` +
            `to known_marketplaces.json. ` +
            `Run: zy plugin marketplace remove "${name}" and re-add it.`,
        )
      }
    }

    // inc-5046: official marketplace fetches from a GCS mirror instead of
    // git-cloning GitHub. Special-cased by NAME (not a new source type) so
    // no data migration is needed — existing known_marketplaces.json entries
    // still say source:'github', which is true (GCS is a mirror).
    if (name === OFFICIAL_MARKETPLACE_NAME) {
      const sha = await fetchOfficialMarketplaceFromGcs(installLocation, getMarketplacesCacheDir())
      if (sha !== null) {
        config[name] = { ...entry, lastUpdated: new Date().toISOString() }
        await saveKnownMarketplacesConfig(config)
        return
      }
      // GCS failed — fall through to git ONLY if the kill-switch allows.
      // Default true (backend write perms are pending as of inc-5046); flip
      // to false via GrowthBook once the backend is confirmed live so new
      // clients NEVER hit GitHub for the official marketplace.
      if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_plugin_official_mkt_git_fallback', true)) {
        // Throw, don't return — every other failure path in this function
        // throws, and callers like ManageMarketplaces.tsx:259 increment
        // updatedCount on any non-throwing return. A silent return would
        // report "Updated 1 marketplace" when nothing was refreshed.
        throw new Error('Official marketplace GCS fetch failed and git fallback is disabled')
      }
      logForDebugging('Official marketplace GCS failed; falling back to git', {
        level: 'warn',
      })
      // ...falls through to source.source === 'github' branch below
    }

    // Update based on source type
    if (source.source === 'github' || source.source === 'git') {
      // Git sources: do in-place git pull
      if (source.source === 'github') {
        // Same SSH/HTTPS fallback as loadAndCacheMarketplace: if the pull
        // succeeds the remote URL in .git/config is used, but a re-clone
        // needs a URL — pick the right protocol up-front and fall back.
        const sshUrl = `git@github.com:${source.repo}.git`
        const httpsUrl = `https://github.com/${source.repo}.git`

        if (isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
          // CCR: always HTTPS (no SSH keys available)
          await cacheMarketplaceFromGit(
            httpsUrl,
            installLocation,
            source.ref,
            source.sparsePaths,
            onProgress,
            options,
          )
        } else {
          const sshConfigured = await isGitHubSshLikelyConfigured()
          const primaryUrl = sshConfigured ? sshUrl : httpsUrl
          const fallbackUrl = sshConfigured ? httpsUrl : sshUrl

          try {
            await cacheMarketplaceFromGit(
              primaryUrl,
              installLocation,
              source.ref,
              source.sparsePaths,
              onProgress,
              options,
            )
          } catch {
            logForDebugging(
              `Marketplace refresh failed with ${sshConfigured ? 'SSH' : 'HTTPS'} for ${source.repo}, falling back to ${sshConfigured ? 'HTTPS' : 'SSH'}`,
              { level: 'info' },
            )
            await cacheMarketplaceFromGit(
              fallbackUrl,
              installLocation,
              source.ref,
              source.sparsePaths,
              onProgress,
              options,
            )
          }
        }
      } else {
        // Explicit git URL: use as-is (no fallback available)
        await cacheMarketplaceFromGit(
          source.url,
          installLocation,
          source.ref,
          source.sparsePaths,
          onProgress,
          options,
        )
      }
      // Validate that marketplace.json still exists after update
      // The repo may have been restructured or deprecated
      try {
        await readCachedMarketplace(installLocation)
      } catch {
        const sourceDisplay =
          source.source === 'github' ? source.repo : redactUrlCredentials(source.url)
        const reason =
          name === 'zy-code-plugins'
            ? `We've deprecated "zy-code-plugins" in favor of "zy-plugins-official".`
            : `This marketplace may have been deprecated or moved to a new location.`
        throw new Error(
          `The marketplace.json file is no longer present in this repository.\n\n` +
            `${reason}\n` +
            `Source: ${sourceDisplay}\n\n` +
            `You can remove this marketplace with: zy plugin marketplace remove "${name}"`,
        )
      }
    } else if (source.source === 'url') {
      // URL sources: re-download to existing file
      await cacheMarketplaceFromUrl(source.url, installLocation, source.headers, onProgress)
    } else if (isLocalMarketplaceSource(source)) {
      // Local sources: no remote to update from, but validate the file still exists and is valid
      safeCallProgress(onProgress, 'Validating local marketplace')
      // Read and validate to ensure the marketplace file is still valid
      await readCachedMarketplace(installLocation)
    } else {
      throw new Error(`Unsupported marketplace source type for refresh`)
    }

    // Update lastUpdated timestamp
    config[name]!.lastUpdated = new Date().toISOString()
    await saveKnownMarketplacesConfig(config)

    logForDebugging(`Successfully refreshed marketplace: ${name}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Failed to refresh marketplace ${name}: ${errorMessage}`, {
      level: 'error',
    })
    throw new Error(`Failed to refresh marketplace '${name}': ${errorMessage}`)
  }
}

/**
 * 设置 marketplace 的 autoUpdate 标志
 *
 * 当启用 autoUpdate 时，marketplace 及其已安装的插件
 * 将在启动时自动更新。
 *
 * @param name - 要更新的 marketplace 名称
 * @param autoUpdate - 是否启用自动更新
 * @throws 如果 marketplace 未找到则抛出异常
 */
export async function setMarketplaceAutoUpdate(name: string, autoUpdate: boolean): Promise<void> {
  const config = await loadKnownMarketplacesConfig()
  const entry = config[name]

  if (!entry) {
    throw new Error(
      `Marketplace '${name}' not found. Available marketplaces: ${Object.keys(config).join(', ')}`,
    )
  }

  // Seed-managed marketplaces always have autoUpdate: false (read-only, git-pull
  // would fail). Toggle appears to work but registerSeedMarketplaces overwrites
  // it on next startup. Error with guidance instead of silent revert.
  const seedDir = seedDirFor(entry.installLocation)
  if (seedDir) {
    throw new Error(
      `Marketplace '${name}' is seed-managed (${seedDir}) and ` +
        `auto-update is always disabled for seed content. ` +
        `To update: ask your admin to update the seed.`,
    )
  }

  // 仅在值实际变化时更新
  if (entry.autoUpdate === autoUpdate) {
    return
  }

  config[name] = {
    ...entry,
    autoUpdate,
  }
  await saveKnownMarketplacesConfig(config)

  // 如果在 settings 中声明了则也更新意图 — 写入声明它的
  // 相同源以避免在错误的作用域创建重复
  const declaringSource = getMarketplaceDeclaringSource(name)
  if (declaringSource) {
    const declared = getSettingsForSource(declaringSource)?.extraKnownMarketplaces?.[name]
    if (declared) {
      saveMarketplaceToSettings(name, { source: declared.source, autoUpdate }, declaringSource)
    }
  }

  logForDebugging(`Set autoUpdate=${autoUpdate} for marketplace: ${name}`)
}

export const _test = {
  redactUrlCredentials,
}
