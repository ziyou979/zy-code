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

import { join, sep } from 'node:path'
import isEqual from 'lodash-es/isEqual.js'
import { logForDebugging } from '../../../utils/debug.js'
import { ConfigParseError, errorMessage, isENOENT } from '../../../utils/errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../../shell/execFileNoThrow.js'
import { getFsImplementation } from '../../../utils/fsOperations.js'
import { gitExe } from '../../../utils/git.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../settings/settings.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../../../utils/slowOperations.js'
import { getAddDirEnabledPlugins, getAddDirExtraMarketplaces } from '../addDirPluginSettings.js'
import { OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE } from '../officialMarketplace.js'
import { getPluginSeedDirs, getPluginsDirectory } from '../pluginDirectories.js'
import { parsePluginIdentifier } from '../pluginIdentifier.js'
import {
  type KnownMarketplace,
  type KnownMarketplacesFile,
  KnownMarketplacesFileSchema,
  type MarketplaceSource,
  type PluginMarketplace,
} from '../schemas.js'
import { getMarketplace, readCachedMarketplace } from './sourceCache.js'
/**
 * 加载和缓存 marketplace 的结果
 */
export type LoadedPluginMarketplace = {
  marketplace: PluginMarketplace
  cachePath: string
}

/**
 * 获取已知 marketplace 配置文件的路径
 * 使用函数而非常量允许在测试中正确模拟
 */
export function getKnownMarketplacesFile(): string {
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

export async function readSeedKnownMarketplaces(
  seedDir: string,
): Promise<KnownMarketplacesConfig | null> {
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
export async function findSeedMarketplaceLocation(
  seedDir: string,
  name: string,
): Promise<string | null> {
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
export function seedDirFor(installLocation: string): string | undefined {
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
export const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0', // 防止终端凭据提示
  GIT_ASKPASS: '', // 禁用 askpass GUI 程序
}

export const DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120 * 1000

export function getPluginGitTimeoutMs(): number {
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
export async function gitSubmoduleUpdate(
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
export function enhanceGitPullErrorMessages(result: {
  code: number
  stderr: string
  error?: string
}): {
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
export async function isGitHubSshLikelyConfigured(): Promise<boolean> {
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
export function isAuthenticationError(stderr: string): boolean {
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
export function extractSshHost(gitUrl: string): string | null {
  const match = gitUrl.match(/^[^@]+@([^:]+):/)
  return match?.[1] ?? null
}
