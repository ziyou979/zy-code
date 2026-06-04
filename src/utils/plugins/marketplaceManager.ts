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
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { ConfigParseError, errorMessage, getErrnoCode, isENOENT, toError } from '../errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'
import { gitExe } from '../git.js'
import { logError } from '../log.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { jsonParse, jsonStringify, writeFileSync_DEPRECATED } from '../slowOperations.js'
import { getAddDirEnabledPlugins, getAddDirExtraMarketplaces } from './addDirPluginSettings.js'
import { markPluginVersionOrphaned } from './cacheUtils.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { removeAllPluginsForMarketplace } from './installedPluginsManager.js'
import {
  extractHostFromSource,
  formatSourceForDisplay,
  getHostPatternsFromAllowlist,
  getStrictKnownMarketplaces,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
} from './marketplaceHelpers.js'
import { OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE } from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'
import { deletePluginDataDir, getPluginSeedDirs, getPluginsDirectory } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { deletePluginOptions } from './pluginOptionsStorage.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplace,
  type KnownMarketplacesFile,
  KnownMarketplacesFileSchema,
  type MarketplaceSource,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  PluginMarketplaceSchema,
  validateOfficialNameSource,
} from './schemas.js'

/**
 * 加载和缓存 marketplace 的结果
 */
type LoadedPluginMarketplace = {
  marketplace: PluginMarketplace
  cachePath: string
}

/**
 * 获取已知 marketplace 配置文件的路径
 * 使用函数而非常量允许在测试中正确模拟
 */
function getKnownMarketplacesFile(): string {
  return join(getPluginsDirectory(), 'known_marketplaces.json')
}

/**
 * 获取 marketplace 缓存目录的路径
 * 使用函数而非常量允许在测试中正确模拟
 */
export function getMarketplacesCacheDir(): string {
  return join(getPluginsDirectory(), 'marketplaces')
}

/**
 * 获取 marketplace 数据的记忆化内部函数。
 * 从磁盘或网络加载后将 marketplace 缓存在内存中。
 */

/**
 * 清除所有缓存的 marketplace 数据（用于测试）
 */
export function clearMarketplacesCache(): void {
  getMarketplace.cache?.clear?.()
}

/**
 * 已知 marketplace 的配置
 */
export type KnownMarketplacesConfig = KnownMarketplacesFile

/**
 * 声明的 marketplace 条目（意图层）。
 *
 * 结构上与 settings `extraKnownMarketplaces` 条目兼容，但
 * 为隐式内置声明添加了 `sourceIsFallback`。这不是
 * settings-schema 字段 — 它只在代码中设置（从不从 JSON 解析）。
 */
export type DeclaredMarketplace = {
  source: MarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  /**
   * 存在即可。设置时，diffMarketplaces 将已物化的条目视为
   * upToDate，无论源的形状如何 — 永不报告 sourceChanged。
   *
   * 用于隐式的官方 marketplace 声明：我们想要“如果缺失则从
   * GitHub 克隆”，而不是“如果在不同源下存在则用 GitHub 替换”。
   * 没有这个，在内部镜像源下注册官方 marketplace 的
   * 种子目录会被 GitHub 重新克隆覆盖。
   */
  sourceIsFallback?: boolean
}

/**
 * 从合并的 settings 和 --add-dir 源获取声明的 marketplace 意图。
 * 这是应该存在的内容 — 被协调器用来发现差异。
 *
 * 当任何已启用的插件引用它时，官方 marketplace 会以
 * `sourceIsFallback: true` 被隐式声明。
 */
export function getDeclaredMarketplaces(): Record<string, DeclaredMarketplace> {
  const implicit: Record<string, DeclaredMarketplace> = {}

  // 只有官方 marketplace 可以被隐式声明 — 它是我们知道的唯一
  // 内置源。其他 marketplace 没有可注入的默认源。
  // 显式禁用的条目（value: false）不算在内。
  const enabledPlugins = {
    ...getAddDirEnabledPlugins(),
    ...(getInitialSettings().enabledPlugins ?? {}),
  }
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    if (value && parsePluginIdentifier(pluginId).marketplace === OFFICIAL_MARKETPLACE_NAME) {
      implicit[OFFICIAL_MARKETPLACE_NAME] = {
        source: OFFICIAL_MARKETPLACE_SOURCE,
        sourceIsFallback: true,
      }
      break
    }
  }

  // 最低优先级：隐式 < --add-dir < 合并的 settings。
  // --add-dir 或 settings 中对 zy-plugins-official 的显式
  // extraKnownMarketplaces 条目胜出。
  return {
    ...implicit,
    ...getAddDirExtraMarketplaces(),
    ...(getInitialSettings().extraKnownMarketplaces ?? {}),
  } as Record<string, DeclaredMarketplace>
}

/**
 * 查找哪个可编辑的 settings 源声明了一个 marketplace。
 * 按优先级反序检查（最高优先级在最后），因此
 * 结果是在合并视图中“胜出”的源。
 * 如果 marketplace 未在任何可编辑源中声明则返回 null。
 */
export function getMarketplaceDeclaringSource(
  name: string,
): 'userSettings' | 'projectSettings' | 'localSettings' | null {
  // 先检查最高优先级的可编辑源 — 在合并视图中
  // 胜出的那个就是我们应该回写的目标。
  const editableSources: Array<'localSettings' | 'projectSettings' | 'userSettings'> = [
    'localSettings',
    'projectSettings',
    'userSettings',
  ]

  for (const source of editableSources) {
    const settings = getSettingsForSource(source)
    if (settings?.extraKnownMarketplaces?.[name]) {
      return source
    }
  }
  return null
}

/**
 * 将 marketplace 条目保存到 settings（意图层）。
 * 不触及 known_marketplaces.json（状态层）。
 *
 * @param name - marketplace 名称
 * @param entry - marketplace 配置
 * @param settingSource - 要写入的 settings 源（默认为 userSettings）
 */
export function saveMarketplaceToSettings(
  name: string,
  entry: DeclaredMarketplace,
  settingSource: 'userSettings' | 'projectSettings' | 'localSettings' = 'userSettings',
): void {
  const existing = getSettingsForSource(settingSource) ?? {}
  const current = { ...existing.extraKnownMarketplaces }
  current[name] = entry
  updateSettingsForSource(settingSource, { extraKnownMarketplaces: current })
}

/**
 * 从磁盘加载已知 marketplace 配置
 *
 * 读取 ~/.zy/plugins/known_marketplaces.json 配置文件，
 * 其中包含 marketplace 名称到其源和元数据的映射。
 *
 * 配置文件内容示例：
 * ```json
 * {
 *   "official-marketplace": {
 *     "source": { "source": "url", "url": "https://example.com/marketplace.json" },
 *     "installLocation": "/Users/me/.zy/plugins/marketplaces/official-marketplace.json",
 *     "lastUpdated": "2024-01-15T10:30:00.000Z"
 *   },
 *   "company-plugins": {
 *     "source": { "source": "github", "repo": "mycompany/plugins" },
 *     "installLocation": "/Users/me/.zy/plugins/marketplaces/company-plugins",
 *     "lastUpdated": "2024-01-14T15:45:00.000Z"
 *   }
 * }
 * ```
 *
 * @returns 将 marketplace 名称映射到其元数据的配置对象
 */
export async function loadKnownMarketplacesConfig(): Promise<KnownMarketplacesConfig> {
  const fs = getFsImplementation()
  const configFile = getKnownMarketplacesFile()

  try {
    const content = await fs.readFile(configFile, {
      encoding: 'utf-8',
    })
    const data = jsonParse(content)
    // 根据 schema 验证
    const parsed = KnownMarketplacesFileSchema().safeParse(data)
    if (!parsed.success) {
      const errorMsg = `Marketplace configuration file is corrupted: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      logForDebugging(errorMsg, {
        level: 'error',
      })
      throw new ConfigParseError(errorMsg, configFile, data)
    }
    return parsed.data
  } catch (error) {
    if (isENOENT(error)) {
      return {}
    }
    // 如果已经是 ConfigParseError，重新抛出
    if (error instanceof ConfigParseError) {
      throw error
    }
    // 对于 JSON 解析错误或 I/O 错误，抛出带有帮助信息的错误
    const errorMsg = `Failed to load marketplace configuration: ${errorMessage(error)}`
    logForDebugging(errorMsg, {
      level: 'error',
    })
    throw new Error(errorMsg)
  }
}

/**
 * 加载已知 marketplace 配置，出错时返回 {} 而不是抛出异常。
 *
 * 在只读路径（插件加载、功能检查）上使用，其中损坏的配置
 * 应优雅降级而非崩溃。不要在加载→修改→保存的路径上使用 —
 * 在那里返回 {} 会导致保存时用仅包含新条目的内容覆写损坏的文件，
 * 永久销毁用户的其他条目。抛出异常的变体保留文件，
 * 以便用户修复损坏并恢复。
 */
export async function loadKnownMarketplacesConfigSafe(): Promise<KnownMarketplacesConfig> {
  try {
    return await loadKnownMarketplacesConfig()
  } catch {
    // 内部函数已通过 logForDebugging 记录。不要在此 logError —
    // 损坏的用户配置不是 ZY Code 的 bug，不应写入错误文件。
    return {}
  }
}

/**
 * 将已知 marketplace 配置保存到磁盘
 *
 * 将配置写入 ~/.zy/plugins/known_marketplaces.json，
 * 如果目录结构不存在则创建它。
 *
 * @param config - 要保存的 marketplace 配置
 */
export async function saveKnownMarketplacesConfig(config: KnownMarketplacesConfig): Promise<void> {
  // 保存前验证
  const parsed = KnownMarketplacesFileSchema().safeParse(config)
  const configFile = getKnownMarketplacesFile()

  if (!parsed.success) {
    throw new ConfigParseError(
      `Invalid marketplace config: ${parsed.error.message}`,
      configFile,
      config,
    )
  }

  const fs = getFsImplementation()
  // 从配置文件路径获取目录以确保一致性
  const dir = join(configFile, '..')
  await fs.mkdir(dir)
  writeFileSync_DEPRECATED(configFile, jsonStringify(parsed.data, null, 2), {
    encoding: 'utf-8',
    flush: true,
  })
}

/**
 * 将只读种子目录中的 marketplace 注册到主
 * known_marketplaces.json 中。
 *
 * 种子的 known_marketplaces.json 包含指向种子目录本身的
 * installLocation 路径。将这些条目注册到主 JSON 中使它们
 * 对所有 marketplace 读取器（getMarketplaceCacheOnly、
 * getPluginByIdCacheOnly 等）可见，无需任何加载器更改 —
 * 它们只是跟随 installLocation 指向的位置。
 *
 * 对于种子中声明的 marketplace，种子条目始终胜出 — 种子是
 * 管理员管理的（烘焙到容器镜像中）。如果管理员在新镜像中
 * 更新种子，这些更改会在下次启动时传播。用户通过
 * `plugin disable` 退出种子插件，而不是删除 marketplace。
 *
 * 对于多个种子目录（路径分隔符分隔），第一个种子胜出：
 * 被较早种子声明的 marketplace 名称会被后续种子跳过。
 *
 * autoUpdate 被强制为 false，因为种子是只读的，git-pull 会失败。
 * installLocation 从运行时 seedDir 计算，而不是信任种子 JSON 中的
 * 值（处理多阶段 Docker 挂载路径漂移）。
 *
 * 幂等：种子未变的第二次调用不写入任何内容。
 *
 * @returns 如果写入/更改了任何 marketplace 条目则返回 true（调用者应
 *   清除缓存，以便早期插件加载传递不会保留过时的
 *   "marketplace not found" 状态）
 */
export async function registerSeedMarketplaces(): Promise<boolean> {
  const seedDirs = getPluginSeedDirs()
  if (seedDirs.length === 0) {
    return false
  }

  const primary = await loadKnownMarketplacesConfig()
  // 此注册过程中第一个种子胜出。不能单独使用 isEqual 检查
  // — 同名的两个种子会有不同的 installLocations。
  const claimed = new Set<string>()
  let changed = 0

  for (const seedDir of seedDirs) {
    const seedConfig = await readSeedKnownMarketplaces(seedDir)
    if (!seedConfig) {
      continue
    }

    for (const [name, seedEntry] of Object.entries(seedConfig)) {
      if (claimed.has(name)) {
        continue
      }

      // 相对于此 seedDir 计算 installLocation，而非烘焙到种子 JSON
      // 中的构建时路径。处理多阶段 Docker 构建，其中种子被
      // 挂载在与构建时不同的路径上。
      const resolvedLocation = await findSeedMarketplaceLocation(seedDir, name)
      if (!resolvedLocation) {
        // 种子内容缺失（不完整的构建）— 保持主配置不变，但
        // 也不声明该名称：后续种子可能有工作内容。
        logForDebugging(
          `Seed marketplace '${name}' not found under ${seedDir}/marketplaces/, skipping`,
          { level: 'warn' },
        )
        continue
      }
      claimed.add(name)

      const desired: KnownMarketplace = {
        source: seedEntry.source,
        installLocation: resolvedLocation,
        lastUpdated: seedEntry.lastUpdated,
        autoUpdate: false,
      }

      // 如果主配置已匹配则跳过 — 幂等空操作，不写入。
      if (isEqual(primary[name], desired)) {
        continue
      }

      // 种子胜出 — 管理员管理。覆写任何现有的主条目。
      primary[name] = desired
      changed++
    }
  }

  if (changed > 0) {
    await saveKnownMarketplacesConfig(primary)
    logForDebugging(`Synced ${changed} marketplace(s) from seed dir(s)`)
    return true
  }
  return false
}

async function readSeedKnownMarketplaces(seedDir: string): Promise<KnownMarketplacesConfig | null> {
  const seedJsonPath = join(seedDir, 'known_marketplaces.json')
  try {
    const content = await getFsImplementation().readFile(seedJsonPath, {
      encoding: 'utf-8',
    })
    const parsed = KnownMarketplacesFileSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `Seed known_marketplaces.json invalid at ${seedDir}: ${parsed.error.message}`,
        { level: 'warn' },
      )
      return null
    }
    return parsed.data
  } catch (e) {
    if (!isENOENT(e)) {
      logForDebugging(`Failed to read seed known_marketplaces.json at ${seedDir}: ${e}`, {
        level: 'warn',
      })
    }
    return null
  }
}

/**
 * 按名称在种子目录中定位 marketplace。
 *
 * 探测 seedDir/marketplaces/ 下的规范位置，而不是信任种子
 * 存储的 installLocation（可能有来自不同构建时挂载点的
 * 过时绝对路径）。
 *
 * @returns 可读位置，或如果两种格式都不存在/验证失败则返回 null
 */
async function findSeedMarketplaceLocation(seedDir: string, name: string): Promise<string | null> {
  const dirCandidate = join(seedDir, 'marketplaces', name)
  const jsonCandidate = join(seedDir, 'marketplaces', `${name}.json`)
  for (const candidate of [dirCandidate, jsonCandidate]) {
    try {
      await readCachedMarketplace(candidate)
      return candidate
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 如果 installLocation 指向已配置的种子目录，返回该种子目录。
 * 种子管理的条目是管理员控制的 — 用户无法
 * 删除/刷新/修改它们（它们会在下次启动时被
 * registerSeedMarketplaces 覆写）。返回特定种子让错误消息能指名它。
 */
function seedDirFor(installLocation: string): string | undefined {
  return getPluginSeedDirs().find(
    (d) => installLocation === d || installLocation.startsWith(d + sep),
  )
}

/**
 * Git pull 操作（导出用于测试）
 *
 * 拉取最新更改，具有可配置的超时（默认 120 秒，通过 ZY_CODE_PLUGIN_GIT_TIMEOUT_MS 覆盖）。
 * 为常见失败场景提供有帮助的错误消息。
 * 如果指定了 ref，则获取并检出该特定分支或标签。
 */
// 防止 git 提示输入凭据的环境变量
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0', // 防止终端凭据提示
  GIT_ASKPASS: '', // 禁用 askpass GUI 程序
}

const DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120 * 1000

function getPluginGitTimeoutMs(): number {
  const envValue = process.env.ZY_CODE_PLUGIN_GIT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_PLUGIN_GIT_TIMEOUT_MS
}

export async function gitPull(
  cwd: string,
  ref?: string,
  options?: { disableCredentialHelper?: boolean; sparsePaths?: string[] },
): Promise<{ code: number; stderr: string }> {
  logForDebugging(`git pull: cwd=${cwd} ref=${ref ?? 'default'}`)
  const env = { ...process.env, ...GIT_NO_PROMPT_ENV }
  const credentialArgs = options?.disableCredentialHelper ? ['-c', 'credential.helper='] : []

  if (ref) {
    const fetchResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'fetch', 'origin', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )

    if (fetchResult.code !== 0) {
      return enhanceGitPullErrorMessages(fetchResult)
    }

    const checkoutResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'checkout', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )

    if (checkoutResult.code !== 0) {
      return enhanceGitPullErrorMessages(checkoutResult)
    }

    const pullResult = await execFileNoThrowWithCwd(
      gitExe(),
      [...credentialArgs, 'pull', 'origin', ref],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )
    if (pullResult.code !== 0) {
      return enhanceGitPullErrorMessages(pullResult)
    }
    await gitSubmoduleUpdate(cwd, credentialArgs, env, options?.sparsePaths)
    return pullResult
  }

  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [...credentialArgs, 'pull', 'origin', 'HEAD'],
    { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
  )
  if (result.code !== 0) {
    return enhanceGitPullErrorMessages(result)
  }
  await gitSubmoduleUpdate(cwd, credentialArgs, env, options?.sparsePaths)
  return result
}

/**
 * 在成功 pull 后同步子模块工作目录。gitClone() 使用
 * --recurse-submodules，但 gitPull() 没有 — 父仓库的子模块
 * 指针会前进而工作目录保留在旧提交，导致 marketplace
 * 更新后子模块中的插件源无法解析。
 * 非致命：子模块更新失败只记录警告；大多数 marketplace
 * 根本不使用子模块。(gh-30696)
 *
 * sparse 克隆跳过 — gitClone 的 sparse 路径故意省略
 * --recurse-submodules 以保留部分克隆的带宽节省，而
 * .gitmodules 是 cone 模式 sparse-checkout 始终物化的根文件，
 * 因此仅通过 .gitmodules 门控无法区分 sparse 仓库。
 *
 * 性能：git-submodule 是一个 bash 脚本，即使没有子模块也会
 * 产生约 20 个子进程（约 35ms+）。.gitmodules 是被跟踪的文件 —
 * 仅当仓库有子模块时 pull 才会物化它 — 因此通过其存在性
 * 门控以在常见情况下跳过进程产生。
 *
 * --init 执行新添加子模块的首次接触克隆，因此保持与
 * gitClone 非 sparse 路径的一致性：StrictHostKeyChecking=yes
 * 用于失败关闭的 SSH（未知主机拒绝而非静默填充
 * known_hosts），--depth 1 用于浅克隆（匹配 --shallow-submodules）。
 * --depth 仅影响尚未初始化的子模块；现有浅子模块不受影响。
 */
async function gitSubmoduleUpdate(
  cwd: string,
  credentialArgs: string[],
  env: NodeJS.ProcessEnv,
  sparsePaths: string[] | undefined,
): Promise<void> {
  if (sparsePaths && sparsePaths.length > 0) {
    return
  }
  const hasGitmodules = await getFsImplementation()
    .stat(join(cwd, '.gitmodules'))
    .then(
      () => true,
      () => false,
    )
  if (!hasGitmodules) {
    return
  }
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    [
      '-c',
      'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      ...credentialArgs,
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
    ],
    { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
  )
  if (result.code !== 0) {
    logForDebugging(`git submodule update failed (non-fatal): ${result.stderr}`, { level: 'warn' })
  }
}

/**
 * 增强 git pull 失败的错误消息
 */
function enhanceGitPullErrorMessages(result: { code: number; stderr: string; error?: string }): {
  code: number
  stderr: string
} {
  if (result.code === 0) {
    return result
  }

  // 通过 error 字段检测 execa 超时终止（当进程被 SIGTERM 终止时
  // stderr 不会包含 "timed out" — 超时信息仅在 error 中）
  if (result.error?.includes('timed out')) {
    const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
    return {
      ...result,
      stderr: `Git pull timed out after ${timeoutSec}s. Try increasing the timeout via ZY_CODE_PLUGIN_GIT_TIMEOUT_MS environment variable.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测 SSH 主机密钥验证失败（在通用的 'Could not read from remote'
  // 捕获之前检查 — 该字符串在两种情况下都会出现）。
  // OpenSSH 对主机不在 known_hosts 中和主机密钥已更改两种情况
  // 都发出 "Host key verification failed" — 后者还包含 "REMOTE HOST
  // IDENTIFICATION HAS CHANGED" 横幅，需要不同的修复方法。
  if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
    return {
      ...result,
      stderr: `SSH host key for this marketplace's git host has changed (server key rotation or possible MITM). Remove the stale entry with: ssh-keygen -R <host>\nThen connect once manually to accept the new key.\n\nOriginal error: ${result.stderr}`,
    }
  }
  if (result.stderr.includes('Host key verification failed')) {
    return {
      ...result,
      stderr: `SSH host key verification failed while updating marketplace. The host key is not in your known_hosts file. Connect once manually to add it (e.g., ssh -T git@<host>), or remove and re-add the marketplace with an HTTPS URL.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测 SSH 认证失败
  if (
    result.stderr.includes('Permission denied (publickey)') ||
    result.stderr.includes('Could not read from remote repository')
  ) {
    return {
      ...result,
      stderr: `SSH authentication failed while updating marketplace. Please ensure your SSH keys are configured.\n\nOriginal error: ${result.stderr}`,
    }
  }

  // 检测网络问题
  if (result.stderr.includes('timed out') || result.stderr.includes('Could not resolve host')) {
    return {
      ...result,
      stderr: `Network error while updating marketplace. Please check your internet connection.\n\nOriginal error: ${result.stderr}`,
    }
  }

  return result
}

/**
 * 检查 SSH 是否可能适用于 GitHub
 * 这是一个快速启发式检查，避免完整克隆超时
 *
 * 使用 StrictHostKeyChecking=yes（而非 accept-new），这样未知的
 * github.com 主机密钥会失败关闭而不是被静默添加到 known_hosts。
 * 这可以防止网络层的中间人攻击在首次接触时污染 known_hosts。
 * 已有 github.com 在 known_hosts 中的用户不受影响；
 * 没有的用户会被引导到 HTTPS 克隆路径。
 *
 * @returns 如果 SSH 认证成功且 github.com 已被信任则返回 true
 */
async function isGitHubSshLikelyConfigured(): Promise<boolean> {
  try {
    // 快速 SSH 连接测试，2 秒超时
    // 如果 SSH 未配置则快速失败
    const result = await execFileNoThrow(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=2',
        '-o',
        'StrictHostKeyChecking=yes',
        'git@github.com',
      ],
      {
        timeout: 3000, // 3 second total timeout
      },
    )

    // SSH 到 github.com 始终返回退出码 1 并带有 "successfully authenticated"
    // 或退出码 255 并带有 "Permission denied" - 我们想要前者
    const configured =
      result.code === 1 &&
      (result.stderr?.includes('successfully authenticated') ||
        result.stdout?.includes('successfully authenticated'))
    logForDebugging(`SSH config check: code=${result.code} configured=${configured}`)
    return configured
  } catch (error) {
    // 任何错误都意味着 SSH 未正确配置
    logForDebugging(`SSH configuration check failed: ${errorMessage(error)}`, {
      level: 'warn',
    })
    return false
  }
}

/**
 * 检查 git 错误是否表示认证失败。
 * 用于为认证失败提供增强的错误消息。
 */
function isAuthenticationError(stderr: string): boolean {
  return (
    stderr.includes('Authentication failed') ||
    stderr.includes('could not read Username') ||
    stderr.includes('terminal prompts disabled') ||
    stderr.includes('403') ||
    stderr.includes('401')
  )
}

/**
 * 从 git URL 中提取 SSH 主机用于错误消息。
 * 匹配 SSH 格式 user@host:path（例如 git@github.com:owner/repo.git）。
 */
function extractSshHost(gitUrl: string): string | null {
  const match = gitUrl.match(/^[^@]+@([^:]+):/)
  return match?.[1] ?? null
}

/**
 * Git clone 操作（导出用于测试）
 *
 * 使用可配置的超时（默认 120 秒，通过 ZY_CODE_PLUGIN_GIT_TIMEOUT_MS 覆盖）
 * 克隆 git 仓库。为常见失败场景提供有帮助的错误消息。
 * 可选检出特定分支或标签。
 *
 * 不禁用凭据助手 — 这允许用户现有的认证设置
 * （gh auth、keychain、git-credential-store 等）为私有仓库原生工作。
 * 交互式提示仍通过 GIT_TERMINAL_PROMPT=0、GIT_ASKPASS=''、
 * stdin: 'ignore' 和 SSH 的 BatchMode=yes 防止。
 *
 * 使用 StrictHostKeyChecking=yes（而非 accept-new）：未知 SSH 主机
 * 失败关闭并给出清晰消息，而不是在首次接触时被静默信任。
 * 对于 github 源类型，预检查会自动将未知主机用户引导到 HTTPS；
 * 对于显式的 git@host:… URL，用户会看到可操作的错误。
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sparsePaths?: string[],
): Promise<{ code: number; stderr: string }> {
  const useSparse = sparsePaths && sparsePaths.length > 0
  const args = [
    '-c',
    'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    'clone',
    '--depth',
    '1',
  ]

  if (useSparse) {
    // Partial clone: skip blob download until checkout, defer checkout until
    // after sparse-checkout is configured. Submodules are intentionally dropped
    // for sparse clones — sparse monorepos rarely need them, and recursing
    // submodules would defeat the partial-clone bandwidth savings.
    args.push('--filter=blob:none', '--no-checkout')
  } else {
    args.push('--recurse-submodules', '--shallow-submodules')
  }

  if (ref) {
    args.push('--branch', ref)
  }

  args.push(gitUrl, targetPath)

  const timeoutMs = getPluginGitTimeoutMs()
  logForDebugging(
    `git clone: url=${redactUrlCredentials(gitUrl)} ref=${ref ?? 'default'} timeout=${timeoutMs}ms`,
  )

  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    timeout: timeoutMs,
    stdin: 'ignore',
    env: { ...process.env, ...GIT_NO_PROMPT_ENV },
  })

  // Scrub credentials from execa's error/stderr fields before any logging or
  // returning. execa's shortMessage embeds the full command line (including
  // the credentialed URL), and result.stderr may also contain it on some git
  // versions.
  const redacted = redactUrlCredentials(gitUrl)
  if (gitUrl !== redacted) {
    if (result.error) {
      result.error = result.error.replaceAll(gitUrl, redacted)
    }
    if (result.stderr) {
      result.stderr = result.stderr.replaceAll(gitUrl, redacted)
    }
  }

  if (result.code === 0) {
    if (useSparse) {
      // Configure the sparse cone, then materialize only those paths.
      // `sparse-checkout set --cone` handles both init and path selection
      // in a single step on git >= 2.25.
      const sparseResult = await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (sparseResult.code !== 0) {
        return {
          code: sparseResult.code,
          stderr: `git sparse-checkout set failed: ${sparseResult.stderr}`,
        }
      }

      const checkoutResult = await execFileNoThrowWithCwd(
        gitExe(),
        // ref was already passed to clone via --branch, so HEAD points to it;
        // if no ref, HEAD points to the remote's default branch.
        ['checkout', 'HEAD'],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (checkoutResult.code !== 0) {
        return {
          code: checkoutResult.code,
          stderr: `git checkout after sparse-checkout failed: ${checkoutResult.stderr}`,
        }
      }
    }
    logForDebugging(`git clone succeeded: ${redactUrlCredentials(gitUrl)}`)
    return result
  }

  logForDebugging(
    `git clone failed: url=${redactUrlCredentials(gitUrl)} code=${result.code} error=${result.error ?? 'none'} stderr=${result.stderr}`,
    { level: 'warn' },
  )

  // Detect timeout kills — when execFileNoThrowWithCwd kills the process via SIGTERM,
  // stderr may only contain partial output (e.g. "Cloning into '...'") with no
  // "timed out" string. Check the error field from execa which contains the
  // timeout message.
  if (result.error?.includes('timed out')) {
    return {
      ...result,
      stderr: `Git clone timed out after ${Math.round(timeoutMs / 1000)}s. The repository may be too large for the current timeout. Set ZY_CODE_PLUGIN_GIT_TIMEOUT_MS to increase it (e.g., 300000 for 5 minutes).\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Enhance error messages for common scenarios
  if (result.stderr) {
    // Host key verification failure — check FIRST, before the generic
    // 'Could not read from remote repository' catch (that string appears
    // in both stderr outputs, so order matters). OpenSSH emits
    // "Host key verification failed" for BOTH host-not-in-known_hosts and
    // host-key-has-changed; distinguish them by the key-change banner.
    if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
      const host = extractSshHost(gitUrl)
      const removeHint = host ? `ssh-keygen -R ${host}` : 'ssh-keygen -R <host>'
      return {
        ...result,
        stderr: `SSH host key has changed (server key rotation or possible MITM). Remove the stale known_hosts entry:\n  ${removeHint}\nThen connect once manually to verify and accept the new key.\n\nOriginal error: ${result.stderr}`,
      }
    }
    if (result.stderr.includes('Host key verification failed')) {
      const host = extractSshHost(gitUrl)
      const connectHint = host ? `ssh -T git@${host}` : 'ssh -T git@<host>'
      return {
        ...result,
        stderr: `SSH host key is not in your known_hosts file. To add it, connect once manually (this will show the fingerprint for you to verify):\n  ${connectHint}\n\nOr use an HTTPS URL instead (recommended for public repos).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('Permission denied (publickey)') ||
      result.stderr.includes('Could not read from remote repository')
    ) {
      return {
        ...result,
        stderr: `SSH authentication failed. Please ensure your SSH keys are configured for GitHub, or use an HTTPS URL instead.\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (isAuthenticationError(result.stderr)) {
      return {
        ...result,
        stderr: `HTTPS authentication failed. Please ensure your credential helper is configured (e.g., gh auth login).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('timed out') ||
      result.stderr.includes('timeout') ||
      result.stderr.includes('Could not resolve host')
    ) {
      return {
        ...result,
        stderr: `Network error or timeout while cloning repository. Please check your internet connection and try again.\n\nOriginal error: ${result.stderr}`,
      }
    }
  }

  // Fallback for empty stderr — gh-28373: user saw "Failed to clone
  // marketplace repository:" with nothing after the colon. Git CAN fail
  // without writing to stderr (stdout instead, or output swallowed by
  // credential helper / signal). execa's error field has the execa-level
  // message (command, exit code, signal); exit code is the minimum.
  if (!result.stderr) {
    return {
      code: result.code,
      stderr:
        result.error ||
        `git clone exited with code ${result.code} (no stderr output). Run with --debug to see the full command.`,
    }
  }

  return result
}

/**
 * marketplace 操作的进度回调。
 *
 * 此回调在 marketplace 操作的各个阶段（下载、git 操作、
 * 验证等）被调用，以提供用户反馈。
 *
 * 重要：实现应在内部处理错误且不抛出异常。
 * 如果回调抛出异常，它会被捕获并记录但不会中止操作。
 *
 * @param message - 要显示给用户的人类可读进度消息
 */
export type MarketplaceProgressCallback = (message: string) => void

/**
 * 安全地调用进度回调，捕获并记录任何错误。
 * 防止回调错误中止 marketplace 操作。
 *
 * @param onProgress - 要调用的进度回调
 * @param message - 传递给回调的进度消息
 */
function safeCallProgress(
  onProgress: MarketplaceProgressCallback | undefined,
  message: string,
): void {
  if (!onProgress) {
    return
  }
  try {
    onProgress(message)
  } catch (callbackError) {
    logForDebugging(`Progress callback error: ${errorMessage(callbackError)}`, {
      level: 'warn',
    })
  }
}

/**
 * 将磁盘上的 sparse-checkout 状态与期望配置协调一致。
 *
 * 在 gitPull 之前运行以处理转换：
 * - Full→Sparse 或 SparseA→SparseB：运行 `sparse-checkout set --cone`（幂等）
 * - Sparse→Full：返回非零以便调用者回退到 rm+重新克隆。避免
 *   在 --filter=blob:none 部分克隆上执行 `sparse-checkout disable`，
 *   这会触发 monorepo 中每个 blob 的延迟获取。
 * - Full→Full（常见情况）：单个本地 `git config --get` 检查，空操作。
 *
 * 此处的失败（ENOENT、非仓库）是无害的 — gitPull 也会失败并
 * 触发克隆路径，从头建立正确状态。
 */
export async function reconcileSparseCheckout(
  cwd: string,
  sparsePaths: string[] | undefined,
): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env, ...GIT_NO_PROMPT_ENV }

  if (sparsePaths && sparsePaths.length > 0) {
    return execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )
  }

  const check = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'core.sparseCheckout'], {
    cwd,
    stdin: 'ignore',
    env,
  })
  if (check.code === 0 && check.stdout.trim() === 'true') {
    return {
      code: 1,
      stderr:
        'sparsePaths removed from config but repository is sparse; re-cloning for full checkout',
    }
  }
  return { code: 0, stderr: '' }
}

/**
 * 从 git 仓库缓存 marketplace
 *
 * 克隆或更新包含 marketplace 数据的 git 仓库。
 * 如果仓库已存在于 cachePath，则拉取最新更改。
 * 如果拉取失败，删除目录并重新克隆。
 *
 * 仓库结构示例：
 * ```
 * my-marketplace/
 *   ├── .zy-plugin/
 *   │   └── marketplace.json    # marketplace 清单的默认位置
 *   ├── plugins/                # 插件实现
 *   └── README.md
 * ```
 *
 * @param gitUrl - 要克隆的 git URL（https 或 ssh）
 * @param cachePath - 克隆/更新仓库的本地目录路径
 * @param ref - 可选的要检出的 git 分支或标签
 * @param onProgress - 可选的报告进度的回调
 */
async function cacheMarketplaceFromGit(
  gitUrl: string,
  cachePath: string,
  ref?: string,
  sparsePaths?: string[],
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  const fs = getFsImplementation()

  // Attempt incremental update; fall back to re-clone if the repo is absent,
  // stale, or otherwise not updatable. Using pull-first avoids a stat-before-operate
  // TOCTOU check: gitPull returns non-zero when cachePath is missing or has no .git.
  const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
  safeCallProgress(onProgress, `Refreshing marketplace cache (timeout: ${timeoutSec}s)…`)

  // Reconcile sparse-checkout config before pulling. If this requires a re-clone
  // (Sparse→Full transition) or fails (missing dir, not a repo), skip straight
  // to the rm+clone fallback.
  const reconcileResult = await reconcileSparseCheckout(cachePath, sparsePaths)
  if (reconcileResult.code === 0) {
    const pullStarted = performance.now()
    const pullResult = await gitPull(cachePath, ref, {
      disableCredentialHelper: options?.disableCredentialHelper,
      sparsePaths,
    })
    logPluginFetch(
      'marketplace_pull',
      gitUrl,
      pullResult.code === 0 ? 'success' : 'failure',
      performance.now() - pullStarted,
      pullResult.code === 0 ? undefined : classifyFetchError(pullResult.stderr),
    )
    if (pullResult.code === 0) {
      return
    }
    logForDebugging(`git pull failed, will re-clone: ${pullResult.stderr}`, {
      level: 'warn',
    })
  } else {
    logForDebugging(`sparse-checkout reconcile requires re-clone: ${reconcileResult.stderr}`)
  }

  try {
    await fs.rm(cachePath, { recursive: true })
    // rm succeeded — a stale or partially-cloned directory existed; log for diagnostics
    logForDebugging(
      `Found stale marketplace directory at ${cachePath}, cleaning up to allow re-clone`,
      { level: 'warn' },
    )
    safeCallProgress(onProgress, 'Found stale directory, cleaning up and re-cloning…')
  } catch (rmError) {
    if (!isENOENT(rmError)) {
      const rmErrorMsg = errorMessage(rmError)
      throw new Error(
        `Failed to clean up existing marketplace directory. Please manually delete the directory at ${cachePath} and try again.\n\nTechnical details: ${rmErrorMsg}`,
      )
    }
    // ENOENT — cachePath didn't exist, this is a fresh install, nothing to clean up
  }

  // Clone the repository (one attempt — no internal retry loop)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  safeCallProgress(
    onProgress,
    `Cloning repository (timeout: ${timeoutSec}s): ${redactUrlCredentials(gitUrl)}${refMessage}`,
  )
  const cloneStarted = performance.now()
  const result = await gitClone(gitUrl, cachePath, ref, sparsePaths)
  logPluginFetch(
    'marketplace_clone',
    gitUrl,
    result.code === 0 ? 'success' : 'failure',
    performance.now() - cloneStarted,
    result.code === 0 ? undefined : classifyFetchError(result.stderr),
  )
  if (result.code !== 0) {
    // Clean up any partial directory created by the failed clone so the next
    // attempt starts fresh. Best-effort: if this fails, the stale dir will be
    // auto-detected and removed at the top of the next call.
    try {
      await fs.rm(cachePath, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error(`Failed to clone marketplace repository: ${result.stderr}`)
  }
  safeCallProgress(onProgress, 'Clone complete, validating marketplace…')
}

/**
 * 编辑头部值以便安全记录
 *
 * @param headers - 要编辑的头部
 * @returns 值被替换为 '***REDACTED***' 的头部
 */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key]) => [key, '***REDACTED***']))
}

/**
 * 编辑 URL 中的用户信息（用户名:密码）以避免记录凭据。
 *
 * Marketplace URL 可能嵌入凭据（例如 GitHub PAT 在
 * `https://user:token@github.com/org/repo` 中）。调试日志和进度输出
 * 写入磁盘并可能包含在错误报告中，因此凭据必须在记录前编辑。
 *
 * 编辑 http(s) URL 中的所有凭据：
 *   https://user:token@github.com/repo → https://***:***@github.com/repo
 *   https://:token@github.com/repo     → https://:***@github.com/repo
 *   https://token@github.com/repo      → https://***@github.com/repo
 *
 * 在 http(s) 上无条件地编辑用户名和密码，因为仅通过解析无法
 * 区分 `placeholder:secret`（例如 x-access-token:ghp_...）
 * 和 `secret:placeholder`（例如 ghp_...:x-oauth-basic）。
 * 非 http(s) 协议（ssh://git@...）和非 URL 输入（`owner/repo` 简写）
 * 保持不变。
 */
function redactUrlCredentials(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isHttp && (parsed.username || parsed.password)) {
      if (parsed.username) {
        parsed.username = '***'
      }
      if (parsed.password) {
        parsed.password = '***'
      }
      return parsed.toString()
    }
  } catch {
    // 不是有效的 URL — 原样安全
  }
  return urlString
}

/**
 * 从 URL 缓存 marketplace
 *
 * 从 URL 下载 marketplace.json 文件并本地保存。
 * 如果缓存目录结构不存在则创建它。
 *
 * marketplace.json 结构示例：
 * ```json
 * {
 *   "name": "my-marketplace",
 *   "owner": { "name": "John Doe", "email": "john@example.com" },
 *   "plugins": [
 *     {
 *       "id": "my-plugin",
 *       "name": "My Plugin",
 *       "source": "./plugins/my-plugin.json",
 *       "category": "productivity",
 *       "description": "A helpful plugin"
 *     }
 *   ]
 * }
 * ```
 *
 * @param url - 要从中下载 marketplace.json 的 URL
 * @param cachePath - 保存下载的 marketplace 的本地文件路径
 * @param customHeaders - 可选的用于认证的自定义 HTTP 头部
 * @param onProgress - 可选的报告进度的回调
 */
async function cacheMarketplaceFromUrl(
  url: string,
  cachePath: string,
  customHeaders?: Record<string, string>,
  onProgress?: MarketplaceProgressCallback,
): Promise<void> {
  const fs = getFsImplementation()

  const redactedUrl = redactUrlCredentials(url)
  safeCallProgress(onProgress, `Downloading marketplace from ${redactedUrl}`)
  logForDebugging(`Downloading marketplace from URL: ${redactedUrl}`)
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    logForDebugging(`Using custom headers: ${jsonStringify(redactHeaders(customHeaders))}`)
  }

  const headers = {
    ...customHeaders,
    // User-Agent 必须在最后以防止被覆盖（与 WebFetch 保持一致）
    'User-Agent': 'Zy-Code-Plugin-Manager',
  }

  let response
  const fetchStarted = performance.now()
  try {
    response = await axios.get(url, {
      timeout: 10000,
      headers,
    })
  } catch (error) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      classifyFetchError(error),
    )
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(
          `Could not connect to ${redactedUrl}. Please check your internet connection and verify the URL is correct.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.code === 'ETIMEDOUT') {
        throw new Error(
          `Request timed out while downloading marketplace from ${redactedUrl}. The server may be slow or unreachable.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.response) {
        throw new Error(
          `HTTP ${error.response.status} error while downloading marketplace from ${redactedUrl}. The marketplace file may not exist at this URL.\n\nTechnical details: ${error.message}`,
        )
      }
    }
    throw new Error(`Failed to download marketplace from ${redactedUrl}: ${errorMessage(error)}`)
  }

  safeCallProgress(onProgress, 'Validating marketplace data')
  // 验证响应是否为有效的 marketplace
  const result = PluginMarketplaceSchema().safeParse(response.data)
  if (!result.success) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      'invalid_schema',
    )
    throw new ConfigParseError(
      `Invalid marketplace schema from URL: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      redactedUrl,
      response.data,
    )
  }
  logPluginFetch('marketplace_url', url, 'success', performance.now() - fetchStarted)

  safeCallProgress(onProgress, 'Saving marketplace to cache')
  // 确保缓存目录存在
  const cacheDir = join(cachePath, '..')
  await fs.mkdir(cacheDir)

  // 写入已验证的 marketplace 文件
  writeFileSync_DEPRECATED(cachePath, jsonStringify(result.data, null, 2), {
    encoding: 'utf-8',
    flush: true,
  })
}

/**
 * 为 marketplace 源生成缓存路径
 */
function getCachePathForSource(source: MarketplaceSource): string {
  const tempName =
    source.source === 'github'
      ? source.repo.replace('/', '-')
      : source.source === 'npm'
        ? source.package.replace('@', '').replace('/', '-')
        : source.source === 'file'
          ? basename(source.path).replace('.json', '')
          : source.source === 'directory'
            ? basename(source.path)
            : `temp_${Date.now()}`
  return tempName
}

/**
 * 使用 Zod schema 解析和验证 JSON 文件
 */
async function parseFileWithSchema<T>(
  filePath: string,
  schema: {
    safeParse: (data: unknown) => {
      success: boolean
      data?: T
      error?: {
        issues: Array<{ path: PropertyKey[]; message: string }>
      }
    }
  },
): Promise<T> {
  const fs = getFsImplementation()
  const content = await fs.readFile(filePath, { encoding: 'utf-8' })
  let data: unknown
  try {
    data = jsonParse(content)
  } catch (error) {
    throw new ConfigParseError(
      `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
      filePath,
      content,
    )
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ConfigParseError(
      `Invalid schema: ${filePath} ${result.error?.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      filePath,
      data,
    )
  }
  return result.data!
}

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
async function loadAndCacheMarketplace(
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
async function readCachedMarketplace(installLocation: string): Promise<PluginMarketplace> {
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
