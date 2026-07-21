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

import { copyFile, readdir, readlink, realpath, rename, rm, rmdir, symlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { logForDebugging } from '../../../services/infra/debug.js'
import { isEnvTruthy } from '../../../services/infra/envUtils.js'
import { getErrnoPath, isENOENT } from '../../../utils/errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../../shell/execFileNoThrow.js'
import { pathExists } from '../../../services/infra/file.js'
import { getFsImplementation } from '../../../services/infra/fsOperations.js'
import { gitExe } from '../../../services/infra/git.js'
import { classifyFetchError, logPluginFetch } from '../fetchTelemetry.js'
import { checkGitAvailable } from '../gitAvailability.js'
import { getPluginSeedDirs, getPluginsDirectory } from '../pluginDirectories.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import { validatePathWithinBase } from '../pluginInstallationHelpers.js'
import { type PluginMarketplaceEntry, type PluginSource } from '../schemas.js'
import { convertDirectoryToZipInPlace, isPluginZipCacheEnabled } from '../zipCache.js'
/**
 * Get the path where plugin cache is stored
 */
export function getPluginCachePath(): string {
  return join(getPluginsDirectory(), 'cache')
}

/**
 * 在指定的基础插件目录下计算版本化缓存路径。
 * 用于探测主缓存和种子缓存。
 *
 * @param baseDir - 基础插件目录（例如 getPluginsDirectory() 或种子目录）
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 版本字符串（semver、git SHA 等）
 * @returns baseDir 下版本化插件目录的绝对路径
 */
export function getVersionedCachePathIn(
  baseDir: string,
  pluginId: string,
  version: string,
): string {
  const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)
  const sanitizedMarketplace = (marketplace || 'unknown').replace(/[^a-zA-Z0-9\-_]/g, '-')
  const sanitizedPlugin = (pluginName || pluginId).replace(/[^a-zA-Z0-9\-_]/g, '-')
  // 清理版本号以防止路径遍历攻击
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
  return join(baseDir, 'cache', sanitizedMarketplace, sanitizedPlugin, sanitizedVersion)
}

/**
 * 获取插件在主插件目录下的版本化缓存路径。
 * 格式：~/.zy/plugins/cache/{marketplace}/{plugin}/{version}/
 *
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 版本字符串（semver、git SHA 等）
 * @returns 版本化插件目录的绝对路径
 */
export function getVersionedCachePath(pluginId: string, version: string): string {
  return getVersionedCachePathIn(getPluginsDirectory(), pluginId, version)
}

/**
 * 获取插件的版本化 ZIP 缓存路径。
 * 这是 getVersionedCachePath 的 zip 缓存变体。
 */
export function getVersionedZipCachePath(pluginId: string, version: string): string {
  return `${getVersionedCachePath(pluginId, version)}.zip`
}

/**
 * 探测种子目录中是否存在该插件版本的已填充缓存。
 * 按优先级顺序检查种子；首个命中者胜出。如果未配置种子
 * 或没有种子包含该版本的已填充目录，则返回 null。
 */
export async function probeSeedCache(pluginId: string, version: string): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    const seedPath = getVersionedCachePathIn(seedDir, pluginId, version)
    try {
      const entries = await readdir(seedPath)
      if (entries.length > 0) {
        return seedPath
      }
    } catch {
      // 尝试下一个种子
    }
  }
  return null
}

/**
 * 当计算版本为 'unknown' 时，探测 seed/cache/<m>/<p>/ 中的实际版本目录。
 * 处理首次启动的先有鸡还是先有蛋问题：版本只能在克隆后才能确定，
 * 但种子中已有克隆。
 *
 * 每个种子仅在恰好存在一个版本时匹配（典型的 BYOC 场景）。
 * 单个种子中有多个版本 → 歧义 → 尝试下一个种子。
 * 按优先级顺序检查种子；首个匹配胜出。
 */
export async function probeSeedCacheAnyVersion(pluginId: string): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    // 版本目录的父目录 — 计算方式与
    // getVersionedCachePathIn 相同，只是没有版本组件。
    const pluginDir = dirname(getVersionedCachePathIn(seedDir, pluginId, '_'))
    try {
      const versions = await readdir(pluginDir)
      if (versions.length !== 1) {
        continue
      }
      const versionDir = join(pluginDir, versions[0]!)
      const entries = await readdir(versionDir)
      if (entries.length > 0) {
        return versionDir
      }
    } catch {
      // 尝试下一个种子
    }
  }
  return null
}

/**
 * 获取插件的旧版（非版本化）缓存路径。
 * 格式：~/.zy/plugins/cache/{plugin-name}/
 *
 * 用于向后兼容现有安装。
 *
 * @param pluginName - 插件名称（不含 marketplace 后缀）
 * @returns 旧版插件目录的绝对路径
 */
export function getLegacyCachePath(pluginName: string): string {
  const cachePath = getPluginCachePath()
  return join(cachePath, pluginName.replace(/[^a-zA-Z0-9\-_]/g, '-'))
}

/**
 * 解析插件路径，回退到旧版位置。
 *
 * 始终：
 * 1. 如果提供了版本，先尝试版本化路径
 * 2. 回退到旧路径以兼容现有安装
 * 3. 为新安装返回版本化路径
 *
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 可选的版本字符串
 * @returns 插件目录的绝对路径
 */
export async function resolvePluginPath(pluginId: string, version?: string): Promise<string> {
  // 先尝试版本化路径
  if (version) {
    const versionedPath = getVersionedCachePath(pluginId, version)
    if (await pathExists(versionedPath)) {
      return versionedPath
    }
  }

  // 回退到旧路径以兼容现有安装
  const pluginName = parsePluginIdentifier(pluginId).name || pluginId
  const legacyPath = getLegacyCachePath(pluginName)
  if (await pathExists(legacyPath)) {
    return legacyPath
  }

  // 为新安装返回版本化路径
  return version ? getVersionedCachePath(pluginId, version) : legacyPath
}

/**
 * 递归复制目录。
 * 导出用于测试目的。
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await getFsImplementation().mkdir(dest)

  const entries = await readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(srcPath)

      // 解析符号链接以获取实际目标路径
      // 这防止 src 和 dest 重叠时的循环符号链接（例如通过符号链）
      let resolvedTarget: string
      try {
        resolvedTarget = await realpath(srcPath)
      } catch {
        // 损坏的符号链接 — 原样复制链接目标
        await symlink(linkTarget, destPath)
        continue
      }

      // 解析源目录以处理符号链接的源目录
      let resolvedSrc: string
      try {
        resolvedSrc = await realpath(src)
      } catch {
        resolvedSrc = src
      }

      // 检查目标是否在源树内（使用正确的路径前缀匹配）
      const srcPrefix = resolvedSrc.endsWith(sep) ? resolvedSrc : resolvedSrc + sep
      if (resolvedTarget.startsWith(srcPrefix) || resolvedTarget === resolvedSrc) {
        // 目标在源树内 — 创建保留相同结构的相对符号链接
        const targetRelativeToSrc = relative(resolvedSrc, resolvedTarget)
        const destTargetPath = join(dest, targetRelativeToSrc)
        const relativeLinkPath = relative(dirname(destPath), destTargetPath)
        await symlink(relativeLinkPath, destPath)
      } else {
        // 目标在源树外 — 使用绝对解析路径
        await symlink(resolvedTarget, destPath)
      }
    }
  }
}

/**
 * 将插件文件复制到版本化缓存目录。
 *
 * 对于本地插件：使用 marketplace.json 中的 entry.source 作为唯一真实来源。
 * 对于远程插件：回退到复制 sourcePath（已下载的内容）。
 *
 * @param sourcePath - 插件源路径（用作远程插件的回退）
 * @param pluginId - 插件标识符，格式为 "name@marketplace"
 * @param version - 用于版本化路径的版本字符串
 * @param entry - 可选的包含 source 字段的 marketplace 条目
 * @param marketplaceDir - 用于解析 entry.source 的 marketplace 目录（远程插件为 undefined）
 * @returns 缓存插件目录的路径
 * @throws 如果源目录未找到则抛出错误
 * @throws 如果复制后目标目录为空则抛出错误
 */
export async function copyPluginToVersionedCache(
  sourcePath: string,
  pluginId: string,
  version: string,
  entry?: PluginMarketplaceEntry,
  marketplaceDir?: string,
): Promise<string> {
  // 启用 zip 缓存时，规范格式是 ZIP 文件
  const zipCacheMode = isPluginZipCacheEnabled()
  const cachePath = getVersionedCachePath(pluginId, version)
  const zipPath = getVersionedZipCachePath(pluginId, version)

  // 如果缓存已存在（目录或 ZIP），直接返回
  if (zipCacheMode) {
    if (await pathExists(zipPath)) {
      logForDebugging(`Plugin ${pluginId} version ${version} already cached at ${zipPath}`)
      return zipPath
    }
  } else if (await pathExists(cachePath)) {
    const entries = await readdir(cachePath)
    if (entries.length > 0) {
      logForDebugging(`Plugin ${pluginId} version ${version} already cached at ${cachePath}`)
      return cachePath
    }
    // 目录存在但为空，删除它以便用内容重新创建
    logForDebugging(`Removing empty cache directory for ${pluginId} at ${cachePath}`)
    await rmdir(cachePath)
  }

  // 种子缓存命中 — 原样返回种子路径（只读，不复制）。
  // 调用者处理目录和 .zip 路径；这里返回目录。
  const seedPath = await probeSeedCache(pluginId, version)
  if (seedPath) {
    logForDebugging(`Using seed cache for ${pluginId}@${version} at ${seedPath}`)
    return seedPath
  }

  // 创建父目录
  await getFsImplementation().mkdir(dirname(cachePath))

  // 对于本地插件：复制 entry.source 目录（单一真实来源）
  // 对于远程插件：marketplaceDir 未定义，回退复制 sourcePath
  if (entry && typeof entry.source === 'string' && marketplaceDir) {
    const sourceDir = validatePathWithinBase(marketplaceDir, entry.source)

    logForDebugging(`Copying source directory ${entry.source} for plugin ${pluginId}`)
    try {
      await copyDir(sourceDir, cachePath)
    } catch (e: unknown) {
      // 仅重新映射顶层 sourceDir 本身的 ENOENT — 递归 copyDir
      // 中的嵌套 ENOENT（损坏的符号链接、竞争的删除）应保留
      // 原始路径在错误中。
      if (isENOENT(e) && getErrnoPath(e) === sourceDir) {
        throw new Error(
          `Plugin source directory not found: ${sourceDir} (from entry.source: ${entry.source})`,
        )
      }
      throw e
    }
  } else {
    // 远程插件（已下载）或没有 entry.source 的插件的回退
    logForDebugging(`Copying plugin ${pluginId} to versioned cache (fallback to full copy)`)
    await copyDir(sourcePath, cachePath)
  }

  // 从缓存中移除 .git 目录（如果存在）
  const gitPath = join(cachePath, '.git')
  await rm(gitPath, { recursive: true, force: true })

  // 验证缓存有内容 — 如果为空则抛出，以便使用回退
  const cacheEntries = await readdir(cachePath)
  if (cacheEntries.length === 0) {
    throw new Error(
      `Failed to copy plugin ${pluginId} to versioned cache: destination is empty after copy`,
    )
  }

  // Zip 缓存模式：将目录转换为 ZIP 并删除目录
  if (zipCacheMode) {
    await convertDirectoryToZipInPlace(cachePath, zipPath)
    logForDebugging(`Successfully cached plugin ${pluginId} as ZIP at ${zipPath}`)
    return zipPath
  }

  logForDebugging(`Successfully cached plugin ${pluginId} at ${cachePath}`)
  return cachePath
}

/**
 * 使用 Node.js URL 解析验证 git URL
 */
export function validateGitUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'file:'].includes(parsed.protocol)) {
      if (!/^git@[a-zA-Z0-9.-]+:/.test(url)) {
        throw new Error(
          `无效的 git URL 协议: ${parsed.protocol}。仅支持 HTTPS、HTTP、file:// 和 SSH (git@) URL。`,
        )
      }
    }
    return url
  } catch {
    if (/^git@[a-zA-Z0-9.-]+:/.test(url)) {
      return url
    }
    throw new Error(`Invalid git URL: ${url}`)
  }
}

/**
 * 使用 npm 从全局缓存安装插件（导出用于测试）
 */
export async function installFromNpm(
  packageName: string,
  targetPath: string,
  options: { registry?: string; version?: string } = {},
): Promise<void> {
  const npmCachePath = join(getPluginsDirectory(), 'npm-cache')

  await getFsImplementation().mkdir(npmCachePath)

  const packageSpec = options.version ? `${packageName}@${options.version}` : packageName
  const packagePath = join(npmCachePath, 'node_modules', packageName)
  const needsInstall = !(await pathExists(packagePath))

  if (needsInstall) {
    logForDebugging(`Installing npm package ${packageSpec} to cache`)
    const args = ['install', packageSpec, '--prefix', npmCachePath]
    if (options.registry) {
      args.push('--registry', options.registry)
    }
    const result = await execFileNoThrow('npm', args, { useCwd: false })

    if (result.code !== 0) {
      throw new Error(`Failed to install npm package: ${result.stderr}`)
    }
  }

  await copyDir(packagePath, targetPath)
  logForDebugging(`Copied npm package ${packageName} from cache to ${targetPath}`)
}

/**
 * 克隆 git 仓库（导出用于测试）
 *
 * @param gitUrl - 要克隆的 git URL
 * @param targetPath - 克隆到的位置
 * @param ref - 可选的分支或标签以检出
 * @param sha - 可选的特定提交 SHA 以检出
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  // 使用 --recurse-submodules 初始化子模块
  // 始终从浅克隆开始以提高效率
  const args = ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules']

  // 为特定 ref 添加 --branch 标志（适用于分支和标签）
  if (ref) {
    args.push('--branch', ref)
  }

  // 指定 sha 时，使用 --no-checkout 因为我们将单独检出 SHA
  if (sha) {
    args.push('--no-checkout')
  }

  args.push(gitUrl, targetPath)

  const cloneStarted = performance.now()
  const cloneResult = await execFileNoThrow(gitExe(), args)

  if (cloneResult.code !== 0) {
    logPluginFetch(
      'plugin_clone',
      gitUrl,
      'failure',
      performance.now() - cloneStarted,
      classifyFetchError(cloneResult.stderr),
    )
    throw new Error(`Failed to clone repository: ${cloneResult.stderr}`)
  }

  // 指定 sha 时，获取并检出特定提交
  if (sha) {
    // 先尝试浅获取特定 SHA（最高效）
    const shallowFetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['fetch', '--depth', '1', 'origin', sha],
      { cwd: targetPath },
    )

    if (shallowFetchResult.code !== 0) {
      // 某些服务器不支持获取任意 SHA
      // 回退到完整获取以获取完整历史
      logForDebugging(`Shallow fetch of SHA ${sha} failed, falling back to unshallow fetch`)
      const unshallowResult = await execFileNoThrowWithCwd(gitExe(), ['fetch', '--unshallow'], {
        cwd: targetPath,
      })

      if (unshallowResult.code !== 0) {
        logPluginFetch(
          'plugin_clone',
          gitUrl,
          'failure',
          performance.now() - cloneStarted,
          classifyFetchError(unshallowResult.stderr),
        )
        throw new Error(`Failed to fetch commit ${sha}: ${unshallowResult.stderr}`)
      }
    }

    // 检出特定提交
    const checkoutResult = await execFileNoThrowWithCwd(gitExe(), ['checkout', sha], {
      cwd: targetPath,
    })

    if (checkoutResult.code !== 0) {
      logPluginFetch(
        'plugin_clone',
        gitUrl,
        'failure',
        performance.now() - cloneStarted,
        classifyFetchError(checkoutResult.stderr),
      )
      throw new Error(`Failed to checkout commit ${sha}: ${checkoutResult.stderr}`)
    }
  }

  // 仅在所有网络操作（克隆 + 可选 SHA 获取）
  // 完成后触发成功 — 与 mcpb 和 marketplace_url 的遥测范围一致。
  logPluginFetch('plugin_clone', gitUrl, 'success', performance.now() - cloneStarted)
}

/**
 * 从 git URL 安装插件
 */
export async function installFromGit(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  const safeUrl = validateGitUrl(gitUrl)
  await gitClone(safeUrl, targetPath, ref, sha)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  logForDebugging(`Cloned repository from ${safeUrl}${refMessage} to ${targetPath}`)
}

/**
 * 从 GitHub 安装插件
 */
export async function installFromGitHub(
  repo: string,
  targetPath: string,
  ref?: string,
  sha?: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository format: ${repo}. Expected format: owner/repo`)
  }
  // CCR 使用 HTTPS（无 SSH 密钥），普通 CLI 使用 SSH
  const gitUrl = isEnvTruthy(process.env.ZY_CODE_REMOTE)
    ? `https://github.com/${repo}.git`
    : `git@github.com:${repo}.git`
  return installFromGit(gitUrl, targetPath, ref, sha)
}

/**
 * 将 git-subdir 的 `url` 字段解析为可克隆的 git URL。
 * 接受 GitHub owner/repo 简写（根据 ZY_CODE_REMOTE 转换为 ssh 或 https）
 * 或任何通过 validateGitUrl 验证的 URL（https、http、file、git@ ssh）。
 */
export function resolveGitSubdirUrl(url: string): string {
  if (/^[a-zA-Z0-9-_.]+\/[a-zA-Z0-9-_.]+$/.test(url)) {
    return isEnvTruthy(process.env.ZY_CODE_REMOTE)
      ? `https://github.com/${url}.git`
      : `git@github.com:${url}.git`
  }
  return validateGitUrl(url)
}

/**
 * 从 git 仓库的子目录安装插件（导出用于测试）。
 *
 * 使用部分克隆（--filter=tree:0）+ sparse-checkout，这样只下载路径上的
 * tree 对象和其下的 blob。对于大型 monorepo，这比完整克隆便宜得多 ——
 * 百万文件仓库的 tree 对象可达数百 MB，这里全部避免了。
 *
 * 执行顺序：
 * 1. clone --depth 1 --filter=tree:0 --no-checkout [--branch ref]
 * 2. sparse-checkout set --cone -- <path>
 * 3. 如果有 sha：fetch --depth 1 origin <sha>（回退：--unshallow），然后
 *    checkout <sha>。部分克隆过滤器存储在远程配置中，后续 fetch 会遵守它；
 *    --unshallow 获取所有提交但 tree 和 blob 保持延迟加载。
 *    如果没有 sha：checkout HEAD（如果使用了 --branch 则指向 ref）。
 * 4. 将 <cloneDir>/<path> 移动到 targetPath 并丢弃克隆。
 *
 * 克隆是临时的 — 它放入同级临时目录中，在子目录提取后被删除。
 * targetPath 最终只包含插件文件，没有 .git 目录。
 */
export async function installFromGitSubdir(
  url: string,
  targetPath: string,
  subdirPath: string,
  ref?: string,
  sha?: string,
): Promise<string | undefined> {
  if (!(await checkGitAvailable())) {
    throw new Error(
      'git-subdir plugin source requires git to be installed and on PATH. ' +
        'Install git (version 2.25 or later for sparse-checkout cone mode) and try again.',
    )
  }

  const gitUrl = resolveGitSubdirUrl(url)
  // 克隆到同级临时目录（同一文件系统 → 重命名可行，无 EXDEV）。
  const cloneDir = `${targetPath}.clone`

  const cloneArgs = ['clone', '--depth', '1', '--filter=tree:0', '--no-checkout']
  if (ref) {
    cloneArgs.push('--branch', ref)
  }
  cloneArgs.push(gitUrl, cloneDir)

  const cloneResult = await execFileNoThrow(gitExe(), cloneArgs)
  if (cloneResult.code !== 0) {
    throw new Error(`Failed to clone repository for git-subdir source: ${cloneResult.stderr}`)
  }

  try {
    const sparseResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', subdirPath],
      { cwd: cloneDir },
    )
    if (sparseResult.code !== 0) {
      throw new Error(
        `git sparse-checkout set failed (git >= 2.25 required for cone mode): ${sparseResult.stderr}`,
      )
    }

    // 在丢弃克隆前捕获解析的提交 SHA。提取的
    // 子目录没有 .git，所以调用者无法在之后 rev-parse。
    // 如果源指定了完整的 40 字符 sha 我们已经知道它；否则
    // 读取 HEAD（在 --branch 后指向 ref 的尖端，或者如果没有
    // 给定 ref 则指向远程默认分支）。
    let resolvedSha: string | undefined

    if (sha) {
      const fetchSha = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', '--depth', '1', 'origin', sha],
        { cwd: cloneDir },
      )
      if (fetchSha.code !== 0) {
        logForDebugging(
          `Shallow fetch of SHA ${sha} failed for git-subdir, falling back to unshallow fetch`,
        )
        const unshallow = await execFileNoThrowWithCwd(gitExe(), ['fetch', '--unshallow'], {
          cwd: cloneDir,
        })
        if (unshallow.code !== 0) {
          throw new Error(`Failed to fetch commit ${sha}: ${unshallow.stderr}`)
        }
      }
      const checkout = await execFileNoThrowWithCwd(gitExe(), ['checkout', sha], { cwd: cloneDir })
      if (checkout.code !== 0) {
        throw new Error(`Failed to checkout commit ${sha}: ${checkout.stderr}`)
      }
      resolvedSha = sha
    } else {
      // checkout HEAD 物化工作树（这是 blob 延迟获取的地方
      // — 慢速、网络绑定的步骤）。它不会移动 HEAD；
      // 克隆时的 --branch 已经定位了它。rev-parse HEAD 是
      // 纯只读的引用查找（无索引锁），因此它可以安全地与
      // checkout 并行运行，我们避免等待网络。
      const [checkout, revParse] = await Promise.all([
        execFileNoThrowWithCwd(gitExe(), ['checkout', 'HEAD'], {
          cwd: cloneDir,
        }),
        execFileNoThrowWithCwd(gitExe(), ['rev-parse', 'HEAD'], {
          cwd: cloneDir,
        }),
      ])
      if (checkout.code !== 0) {
        throw new Error(`git checkout after sparse-checkout failed: ${checkout.stderr}`)
      }
      if (revParse.code === 0) {
        resolvedSha = revParse.stdout.trim()
      }
    }

    // 路径遍历守卫：在移出之前解析+验证子目录
    // 保持在 cloneDir 内。rename ENOENT 被包装为更友好的
    // 消息，引用源路径而非内部临时目录。
    const resolvedSubdir = validatePathWithinBase(cloneDir, subdirPath)
    try {
      await rename(resolvedSubdir, targetPath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        throw new Error(
          `Subdirectory '${subdirPath}' not found in repository ${gitUrl}${ref ? ` (ref: ${ref})` : ''}. ` +
            'Check that the path is correct and exists at the specified ref/sha.',
        )
      }
      throw e
    }

    const refMsg = ref ? ` ref=${ref}` : ''
    const shaMsg = resolvedSha ? ` sha=${resolvedSha}` : ''
    logForDebugging(
      `Extracted subdir ${subdirPath} from ${gitUrl}${refMsg}${shaMsg} to ${targetPath}`,
    )
    return resolvedSha
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
}

/**
 * 从本地路径安装插件
 */
export async function installFromLocal(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source path does not exist: ${sourcePath}`)
  }

  await copyDir(sourcePath, targetPath)

  const gitPath = join(targetPath, '.git')
  await rm(gitPath, { recursive: true, force: true })
}

/**
 * 生成插件的临时缓存名称
 */
export function generateTemporaryCacheNameForPlugin(source: PluginSource): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)

  let prefix: string

  if (typeof source === 'string') {
    prefix = 'local'
  } else {
    switch (source.source) {
      case 'npm':
        prefix = 'npm'
        break
      case 'pip':
        prefix = 'pip'
        break
      case 'github':
        prefix = 'github'
        break
      case 'url':
        prefix = 'git'
        break
      case 'git-subdir':
        prefix = 'subdir'
        break
      default:
        prefix = 'unknown'
    }
  }

  return `temp_${prefix}_${timestamp}_${random}`
}
