/**
 * 管理存储在 installed_plugins.json 中的插件安装元数据。
 *
 * 本模块将插件安装状态（全局）与启用/禁用状态（每个仓库）分离。
 * installed_plugins.json 文件记录：
 * - 全局安装了哪些插件
 * - 安装元数据（版本、时间戳、路径）
 *
 * 启用/禁用状态仍保存在 .zy/settings.json 中，以便按仓库控制。
 *
 * 原因：安装是全局的（插件要么位于磁盘上，要么不在），而启用/禁用状态按仓库
 * 区分（不同项目可能希望启用不同插件）。
 */

import { dirname, join } from 'node:path'
import { logForDebugging } from '../../services/infra/debug.js'
import { errorMessage, isENOENT, toError } from '../../utils/errors.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { logError } from '../../services/infra/log.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../../services/infra/slowOperations.js'
import { getPluginsDirectory } from './pluginDirectories.js'
import {
  type InstalledPlugin,
  InstalledPluginsFileSchemaV2,
  type InstalledPluginsFileV2,
  type PluginInstallationEntry,
  type PluginScope,
} from './schemas.js'

// V2 插件映射的类型别名
type InstalledPluginsMap = Record<string, PluginInstallationEntry[]>

// 可持久化作用域的类型（不包括仅在会话中生效的 'flag'）
export type PersistableScope = Exclude<PluginScope, never> // All scopes are persistable in the schema

import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import { getCwd } from '../environment/cwd.js'
import { getHeadForDir } from '../git/gitFilesystem.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { getInitialSettings, getSettingsForSource } from '../settings/settings.js'
import { getPluginById } from './marketplaceManager.js'
import { parsePluginIdentifier, settingSourceToScope } from './pluginIdentifier.js'
import { getPluginCachePath, getVersionedCachePath } from './pluginLoader.js'

// 用于防止每个会话重复执行迁移的状态
let migrationCompleted = false

/**
 * 已安装插件数据的记忆化缓存（V2 格式）。
 * 文件修改时由 clearInstalledPluginsCache() 清除。
 * 防止在单个 CLI 会话中重复读取文件系统。
 */
let installedPluginsCacheV2: InstalledPluginsFileV2 | null = null

/**
 * 启动时已安装插件的会话级快照。
 * 运行中的会话使用该快照，后台操作不会更新它。
 * 后台更新仅修改磁盘文件。
 */
let inMemoryInstalledPlugins: InstalledPluginsFileV2 | null = null

/**
 * 获取 installed_plugins.json 文件路径。
 */
export function getInstalledPluginsFilePath(): string {
  return join(getPluginsDirectory(), 'installed_plugins.json')
}

/**
 * 获取旧版 installed_plugins_v2.json 文件路径。
 * 仅在迁移时使用，以合并为单个文件。
 */
export function getInstalledPluginsV2FilePath(): string {
  return join(getPluginsDirectory(), 'installed_plugins_v2.json')
}

/**
 * 清除已安装插件缓存。
 * 文件修改后调用此函数以强制重新加载。
 *
 * 注意：这也会清除内存中的会话状态（inMemoryInstalledPlugins）。
 * 大多数情况下，仅在初始化或测试期间调用此函数。
 * 后台更新请使用会保留内存状态的 updateInstallationPathOnDisk()。
 */
export function clearInstalledPluginsCache(): void {
  installedPluginsCacheV2 = null
  inMemoryInstalledPlugins = null
  logForDebugging('Cleared installed plugins cache')
}

/**
 * 确保 installed_plugins.json 为有效的 V2 格式。
 * 每个会话启动时运行一次。
 */
export function migrateToSinglePluginFile(): void {
  if (migrationCompleted) {
    return
  }

  const fs = getFsImplementation()
  const mainFilePath = getInstalledPluginsFilePath()

  try {
    let mainContent: string
    try {
      mainContent = fs.readFileSync(mainFilePath, { encoding: 'utf-8' })
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
      migrationCompleted = true
      return
    }

    const mainData = jsonParse(mainContent)
    if (mainData?.version === 2) {
      migrationCompleted = true
      return
    }

    logForDebugging(
      `installed_plugins.json has unexpected version (${mainData?.version}), treating as new`,
    )
    migrationCompleted = true
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to migrate plugin files: ${errorMsg}`, { level: 'error' })
    logError(toError(error))
    migrationCompleted = true
  }
}

/**
 * 清理旧版非版本化缓存目录。
 *
 * 旧版缓存结构：~/.zy/plugins/cache/{plugin-name}/
 * 版本化缓存结构：~/.zy/plugins/cache/{marketplace}/{plugin}/{version}/
 *
 * 此函数移除未被任何安装记录引用的旧版目录。
 */
function cleanupLegacyCache(v2Data: InstalledPluginsFileV2): void {
  const fs = getFsImplementation()
  const cachePath = getPluginCachePath()
  try {
    // 收集所有被引用的安装路径
    const referencedPaths = new Set<string>()
    for (const installations of Object.values(v2Data.plugins)) {
      for (const entry of installations) {
        referencedPaths.add(entry.installPath)
      }
    }

    // 列出缓存中的顶级目录
    const entries = fs.readdirSync(cachePath)

    for (const dirent of entries) {
      if (!dirent.isDirectory()) {
        continue
      }

      const entry = dirent.name
      const entryPath = join(cachePath, entry)

      // 检查这是版本化缓存（marketplace 目录下包含插件/版本子目录）
      // 还是旧版缓存（扁平的插件目录）
      const subEntries = fs.readdirSync(entryPath)
      const hasVersionedStructure = subEntries.some((subDirent) => {
        if (!subDirent.isDirectory()) {
          return false
        }
        const subPath = join(entryPath, subDirent.name)
        // 检查子目录是否包含版本目录（类似 semver 或 hash）
        const versionEntries = fs.readdirSync(subPath)
        return versionEntries.some((vDirent) => vDirent.isDirectory())
      })

      if (hasVersionedStructure) {
        // 这是具有版本化结构的 marketplace 目录，跳过
        continue
      }

      // 这是旧版扁平缓存目录
      // 检查它是否被任何安装记录引用
      if (!referencedPaths.has(entryPath)) {
        // 未被引用，可以安全删除
        fs.rmSync(entryPath, { recursive: true, force: true })
        logForDebugging(`Cleaned up legacy cache directory: ${entry}`)
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to clean up legacy cache: ${errorMsg}`, {
      level: 'warn',
    })
  }
}

/**
 * 重置迁移状态（用于测试）。
 */
export function resetMigrationState(): void {
  migrationCompleted = false
}

/**
 * 读取 installed_plugins.json 的原始文件数据。
 * 文件不存在时返回 null。
 * 文件存在但无法解析时抛出错误。
 */
function readInstalledPluginsFileRaw(): {
  version: number
  data: unknown
} | null {
  const fs = getFsImplementation()
  const filePath = getInstalledPluginsFilePath()

  let fileContent: string
  try {
    fileContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
  } catch (e) {
    if (isENOENT(e)) {
      return null
    }
    throw e
  }
  const data = jsonParse(fileContent)
  const version = typeof data?.version === 'number' ? data.version : 1
  return { version, data }
}

/**
 * 加载已安装插件。
 *
 * @returns 采用每个插件一个数组结构的 V2 格式数据
 */
export function loadInstalledPlugins(): InstalledPluginsFileV2 {
  // 如有可用缓存则返回缓存数据
  if (installedPluginsCacheV2 !== null) {
    return installedPluginsCacheV2
  }

  const filePath = getInstalledPluginsFilePath()

  try {
    const rawData = readInstalledPluginsFileRaw()

    if (rawData) {
      const validated = InstalledPluginsFileSchemaV2().parse(rawData.data)
      installedPluginsCacheV2 = validated
      logForDebugging(
        `Loaded ${Object.keys(validated.plugins).length} installed plugins from ${filePath}`,
      )
      return validated
    }

    // 文件不存在，返回空数据
    logForDebugging(`installed_plugins.json doesn't exist, returning empty`)
    installedPluginsCacheV2 = { version: 2, plugins: {} }
    return installedPluginsCacheV2
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(
      `Failed to load installed_plugins.json: ${errorMsg}. Starting with empty state.`,
      { level: 'error' },
    )
    logError(toError(error))

    installedPluginsCacheV2 = { version: 2, plugins: {} }
    return installedPluginsCacheV2
  }
}

/**
 * 将已安装插件以 V2 格式保存到 installed_plugins.json。
 * 这是合并 V1/V2 后的唯一事实来源。
 */
function saveInstalledPluginsV2(data: InstalledPluginsFileV2): void {
  const fs = getFsImplementation()
  const filePath = getInstalledPluginsFilePath()

  try {
    fs.mkdirSync(getPluginsDirectory())

    const jsonContent = jsonStringify(data, null, 2)
    writeFileSync_DEPRECATED(filePath, jsonContent, {
      encoding: 'utf-8',
      flush: true,
    })

    // 更新缓存
    installedPluginsCacheV2 = data

    logForDebugging(`Saved ${Object.keys(data.plugins).length} installed plugins to ${filePath}`)
  } catch (error) {
    const _errorMsg = errorMessage(error)
    logError(toError(error))
    throw error
  }
}

/**
 * 在指定作用域添加或更新插件安装记录。
 * 用于每个插件拥有安装记录数组的 V2 格式。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @param scope - 安装作用域（managed/user/project/local）
 * @param installPath - 版本化插件目录路径
 * @param metadata - 附加安装元数据
 * @param projectPath - 项目路径（project/local 作用域必填）
 */
export function addPluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  installPath: string,
  metadata: Partial<PluginInstallationEntry>,
  projectPath?: string,
): void {
  const data = loadInstalledPluginsFromDisk()

  // 获取或创建该插件的数组
  const installations = data.plugins[pluginId] || []

  // 查找此 scope+projectPath 的现有记录
  const existingIndex = installations.findIndex(
    (entry) => entry.scope === scope && entry.projectPath === projectPath,
  )

  const newEntry: PluginInstallationEntry = {
    scope,
    installPath,
    version: metadata.version,
    installedAt: metadata.installedAt || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    gitCommitSha: metadata.gitCommitSha,
    ...(projectPath && { projectPath }),
  }

  if (existingIndex >= 0) {
    installations[existingIndex] = newEntry
    logForDebugging(`Updated installation for ${pluginId} at scope ${scope}`)
  } else {
    installations.push(newEntry)
    logForDebugging(`Added installation for ${pluginId} at scope ${scope}`)
  }

  data.plugins[pluginId] = installations
  saveInstalledPluginsV2(data)
}

/**
 * 从指定作用域移除插件安装记录。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @param scope - 要移除的安装作用域
 * @param projectPath - 项目路径（用于 project/local 作用域）
 */
export function removePluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  projectPath?: string,
): void {
  const data = loadInstalledPluginsFromDisk()
  const installations = data.plugins[pluginId]

  if (!installations) {
    return
  }

  data.plugins[pluginId] = installations.filter(
    (entry) => !(entry.scope === scope && entry.projectPath === projectPath),
  )

  // 没有剩余安装记录时完全移除插件
  if (data.plugins[pluginId].length === 0) {
    delete data.plugins[pluginId]
  }

  saveInstalledPluginsV2(data)
  logForDebugging(`Removed installation for ${pluginId} at scope ${scope}`)
}

// =============================================================================
// 内存与磁盘状态管理（用于非原地更新）
// =============================================================================

/**
 * 获取内存中的已安装插件（会话状态）。
 * 此快照在启动时加载，并在整个会话期间使用。
 * 后台操作不会更新它。
 *
 * @returns 表示会话中已安装插件视图的 V2 格式数据
 */
export function getInMemoryInstalledPlugins(): InstalledPluginsFileV2 {
  if (inMemoryInstalledPlugins === null) {
    inMemoryInstalledPlugins = loadInstalledPlugins()
  }
  return inMemoryInstalledPlugins
}

/**
 * 直接从磁盘加载已安装插件，绕过所有缓存。
 * 后台更新器用它检查变更，且不影响运行中会话的视图。
 *
 * @returns 从磁盘新鲜读取的 V2 格式数据
 */
export function loadInstalledPluginsFromDisk(): InstalledPluginsFileV2 {
  try {
    const rawData = readInstalledPluginsFileRaw()

    if (rawData) {
      return InstalledPluginsFileSchemaV2().parse(rawData.data)
    }

    return { version: 2, plugins: {} }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Failed to load installed plugins from disk: ${errorMsg}`, {
      level: 'error',
    })
    return { version: 2, plugins: {} }
  }
}

/**
 * 仅更新磁盘上的插件安装路径，不修改内存状态。
 * 后台更新器用它在磁盘记录新版本，而会话继续使用旧版本。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @param scope - 安装作用域
 * @param projectPath - 项目路径（用于 project/local 作用域）
 * @param newPath - 新安装路径（指向新版本目录）
 * @param newVersion - 新版本字符串
 */
export function updateInstallationPathOnDisk(
  pluginId: string,
  scope: PersistableScope,
  projectPath: string | undefined,
  newPath: string,
  newVersion: string,
  gitCommitSha?: string,
): void {
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations) {
    logForDebugging(`Cannot update ${pluginId} on disk: plugin not found in installed plugins`)
    return
  }

  const entry = installations.find((e) => e.scope === scope && e.projectPath === projectPath)

  if (entry) {
    entry.installPath = newPath
    entry.version = newVersion
    entry.lastUpdated = new Date().toISOString()
    if (gitCommitSha !== undefined) {
      entry.gitCommitSha = gitCommitSha
    }

    const filePath = getInstalledPluginsFilePath()

    // 写入单个文件（version=2 的 V2 格式）
    writeFileSync_DEPRECATED(filePath, jsonStringify(diskData, null, 2), {
      encoding: 'utf-8',
      flush: true,
    })

    // 磁盘已变更，清除缓存，但不要更新 inMemoryInstalledPlugins
    installedPluginsCacheV2 = null

    logForDebugging(`Updated ${pluginId} on disk to version ${newVersion} at ${newPath}`)
  } else {
    logForDebugging(`Cannot update ${pluginId} on disk: no installation for scope ${scope}`)
  }
  // 注意：inMemoryInstalledPlugins 不会更新
}

/**
 * 检查是否存在待处理更新（磁盘与内存不同）。
 * 后台更新器下载新版本时会出现此情况。
 *
 * @returns 如果任一插件在磁盘与内存中的安装路径不同，则返回 true
 */
export function hasPendingUpdates(): boolean {
  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(diskState.plugins)) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) {
      continue
    }

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        (m) => m.scope === diskEntry.scope && m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        return true // Disk has different version than memory
      }
    }
  }

  return false
}

/**
 * 获取待处理更新数量（磁盘与内存不同的安装记录）。
 *
 * @returns 存在待处理更新的安装记录数量
 */
export function getPendingUpdateCount(): number {
  let count = 0
  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(diskState.plugins)) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) {
      continue
    }

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        (m) => m.scope === diskEntry.scope && m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        count++
      }
    }
  }

  return count
}

/**
 * 获取用于展示的待处理更新详情。
 *
 * @returns 包含 pluginId、scope、oldVersion、newVersion 的对象数组
 */
export function getPendingUpdatesDetails(): Array<{
  pluginId: string
  scope: string
  oldVersion: string
  newVersion: string
}> {
  const updates: Array<{
    pluginId: string
    scope: string
    oldVersion: string
    newVersion: string
  }> = []

  const memoryState = getInMemoryInstalledPlugins()
  const diskState = loadInstalledPluginsFromDisk()

  for (const [pluginId, diskInstallations] of Object.entries(diskState.plugins)) {
    const memoryInstallations = memoryState.plugins[pluginId]
    if (!memoryInstallations) {
      continue
    }

    for (const diskEntry of diskInstallations) {
      const memoryEntry = memoryInstallations.find(
        (m) => m.scope === diskEntry.scope && m.projectPath === diskEntry.projectPath,
      )
      if (memoryEntry && memoryEntry.installPath !== diskEntry.installPath) {
        updates.push({
          pluginId,
          scope: diskEntry.scope,
          oldVersion: memoryEntry.version || 'unknown',
          newVersion: diskEntry.version || 'unknown',
        })
      }
    }
  }

  return updates
}

/**
 * 重置内存中的会话状态。
 * 仅应在启动或测试时调用。
 */
export function resetInMemoryState(): void {
  inMemoryInstalledPlugins = null
}

/**
 * 初始化版本化插件系统。
 * 这会触发 V1→V2 迁移并初始化内存会话状态。
 *
 * 应在所有模式（REPL 和 headless）启动的早期调用。
 *
 * @returns 初始化完成时兑现的 Promise
 */
export async function initializeVersionedPlugins(): Promise<void> {
  // 第 1 步：迁移到单文件格式（合并 V1/V2 文件、清理旧版缓存）
  migrateToSinglePluginFile()

  // 第 2 步：将 settings.json 中的 enabledPlugins 同步到 installed_plugins.json
  // 此操作必须在 CLI 退出前完成（尤其在 headless 模式）
  try {
    await migrateFromEnabledPlugins()
  } catch (error) {
    logError(error)
  }

  // 第 3 步：初始化内存会话状态
  // 调用 getInMemoryInstalledPlugins 会触发：
  // 1. 从磁盘加载
  // 2. 缓存在 inMemoryInstalledPlugins 中作为会话状态
  const data = getInMemoryInstalledPlugins()
  logForDebugging(
    `Initialized versioned plugins system with ${Object.keys(data.plugins).length} plugins`,
  )
}

/**
 * 从 installed_plugins.json 移除属于指定 marketplace 的所有插件记录。
 *
 * 一次加载 V2 数据，查找所有匹配 `@{marketplaceName}` 后缀的插件 ID，
 * 收集其安装路径、移除记录，并保存一次。
 *
 * @param marketplaceName - marketplace 名称（与 `@{name}` 后缀匹配）
 * @returns 已移除记录的 orphanedPaths（供 markPluginVersionOrphaned 使用）和
 *   removedPluginIds（供 deletePluginOptions 使用）
 */
export function removeAllPluginsForMarketplace(marketplaceName: string): {
  orphanedPaths: string[]
  removedPluginIds: string[]
} {
  if (!marketplaceName) {
    return { orphanedPaths: [], removedPluginIds: [] }
  }

  const data = loadInstalledPluginsFromDisk()
  const suffix = `@${marketplaceName}`
  const orphanedPaths = new Set<string>()
  const removedPluginIds: string[] = []

  for (const pluginId of Object.keys(data.plugins)) {
    if (!pluginId.endsWith(suffix)) {
      continue
    }

    for (const entry of data.plugins[pluginId] ?? []) {
      if (entry.installPath) {
        orphanedPaths.add(entry.installPath)
      }
    }

    delete data.plugins[pluginId]
    removedPluginIds.push(pluginId)
    logForDebugging(`Removed installed plugin for marketplace removal: ${pluginId}`)
  }

  if (removedPluginIds.length > 0) {
    saveInstalledPluginsV2(data)
  }

  return { orphanedPaths: Array.from(orphanedPaths), removedPluginIds }
}

/**
 * 谓词：此安装记录是否与当前项目上下文相关？
 *
 * V2 installed_plugins.json 可能包含其他项目的项目作用域记录（单个用户级文件
 * 跟踪所有作用域）。调用者询问“此插件是否已安装”时，几乎总是指“以在这里生效
 * 的方式安装”，而非“安装在此机器任意位置”。见 #29608：DiscoverPlugins.tsx
 * 会隐藏仅安装在无关项目中的插件。
 *
 * - user/managed 作用域：始终相关（全局）
 * - project/local 作用域：仅 projectPath 与当前项目匹配时相关
 *
 * 使用 getOriginalCwd()（而非 getCwd()），因为“当前项目”是启动 ZY Code 的
 * 位置，而不是工作目录后来漂移到的位置。
 */
export function isInstallationRelevantToCurrentProject(inst: PluginInstallationEntry): boolean {
  return inst.scope === 'user' || inst.scope === 'managed' || inst.projectPath === getOriginalCwd()
}

/**
 * 检查插件是否以与当前项目相关的方式安装。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @returns 插件存在 user/managed 作用域安装记录，或 projectPath 与当前项目匹配的
 *   project/local 作用域安装记录时返回 true。仅安装在其他项目中的插件返回 false。
 */
export function isPluginInstalled(pluginId: string): boolean {
  const v2Data = loadInstalledPlugins()
  const installations = v2Data.plugins[pluginId]
  if (!installations || installations.length === 0) {
    return false
  }
  if (!installations.some(isInstallationRelevantToCurrentProject)) {
    return false
  }
  // 插件从 settings.enabledPlugins 加载
  // 如果 settings.enabledPlugins 与 installed_plugins.json 不一致
  // （因 settings.json 被覆盖），则返回 false
  return getInitialSettings().enabledPlugins?.[pluginId] !== undefined
}

/**
 * 仅当插件具有 USER 或 MANAGED 作用域安装记录时返回 true。
 *
 * 在 UI 判断是否应提供安装选项的流程中使用此函数。user/managed 作用域安装意味着
 * 插件处处可用，用户无需添加任何内容。project/local 作用域安装意味着用户可能仍想
 * 在 user 作用域安装，以使其全局可用。
 *
 * gh-29997 / gh-29240 / gh-29392：浏览 UI 依赖 isPluginInstalled() 阻止操作，
 * 该函数对项目作用域安装返回 true，导致用户无法为同一插件添加 user 作用域记录。
 * 后端（installPluginOp → addInstalledPlugin）已经支持每个插件有多个作用域记录，
 * 出错的只有 UI 守卫。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 */
export function isPluginGloballyInstalled(pluginId: string): boolean {
  const v2Data = loadInstalledPlugins()
  const installations = v2Data.plugins[pluginId]
  if (!installations || installations.length === 0) {
    return false
  }
  const hasGlobalEntry = installations.some(
    (entry) => entry.scope === 'user' || entry.scope === 'managed',
  )
  if (!hasGlobalEntry) {
    return false
  }
  // 与 isPluginInstalled 相同的设置不一致守卫：如果 enabledPlugins 被覆盖，
  // 则视为未安装，使用户可以重新启用。
  return getInitialSettings().enabledPlugins?.[pluginId] !== undefined
}

/**
 * 添加或更新插件的安装元数据。
 *
 * 实现双写：同时更新 V1 和 V2 文件。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @param metadata - 安装元数据
 * @param scope - 安装作用域（为向后兼容默认为 'user'）
 * @param projectPath - 项目路径（用于 project/local 作用域）
 */
export function addInstalledPlugin(
  pluginId: string,
  metadata: InstalledPlugin,
  scope: PersistableScope = 'user',
  projectPath?: string,
): void {
  const v2Data = loadInstalledPluginsFromDisk()
  const v2Entry: PluginInstallationEntry = {
    scope,
    installPath: metadata.installPath,
    version: metadata.version,
    installedAt: metadata.installedAt,
    lastUpdated: metadata.lastUpdated,
    gitCommitSha: metadata.gitCommitSha,
    ...(projectPath && { projectPath }),
  }

  // 获取或创建该插件的数组（保留其他作用域的安装记录）
  const installations = v2Data.plugins[pluginId] || []

  // 查找此 scope+projectPath 的现有记录
  const existingIndex = installations.findIndex(
    (entry) => entry.scope === scope && entry.projectPath === projectPath,
  )

  const isUpdate = existingIndex >= 0
  if (isUpdate) {
    installations[existingIndex] = v2Entry
  } else {
    installations.push(v2Entry)
  }

  v2Data.plugins[pluginId] = installations
  saveInstalledPluginsV2(v2Data)

  logForDebugging(
    `${isUpdate ? 'Updated' : 'Added'} installed plugin: ${pluginId} (scope: ${scope})`,
  )
}

/**
 * 从已安装插件注册表中移除插件。
 * 插件卸载时应调用此函数。
 *
 * 注意：此函数只更新注册表文件。要完全卸载，请随后调用 deletePluginCache()
 * 移除物理文件。
 *
 * @param pluginId - "plugin@marketplace" 格式的插件 ID
 * @returns 已移除的插件元数据，若未安装则返回 undefined
 */
export function removeInstalledPlugin(pluginId: string): InstalledPlugin | undefined {
  const v2Data = loadInstalledPluginsFromDisk()
  const installations = v2Data.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return undefined
  }

  // 从第一条安装记录提取 V1 兼容的元数据作为返回值
  const firstInstall = installations[0]
  const metadata: InstalledPlugin | undefined = firstInstall
    ? {
        version: firstInstall.version || 'unknown',
        installedAt: firstInstall.installedAt || new Date().toISOString(),
        lastUpdated: firstInstall.lastUpdated,
        installPath: firstInstall.installPath,
        gitCommitSha: firstInstall.gitCommitSha,
      }
    : undefined

  delete v2Data.plugins[pluginId]
  saveInstalledPluginsV2(v2Data)

  logForDebugging(`Removed installed plugin: ${pluginId}`)

  return metadata
}

/**
 * 删除插件的缓存目录。
 * 这会从磁盘物理移除插件文件。
 *
 * @param installPath - 插件缓存目录的绝对路径
 */
/**
 * 导出 getGitCommitSha 供 pluginInstallationHelpers 使用。
 */
export { getGitCommitSha }

export function deletePluginCache(installPath: string): void {
  const fs = getFsImplementation()

  try {
    fs.rmSync(installPath, { recursive: true, force: true })
    logForDebugging(`Deleted plugin cache at ${installPath}`)

    // 清理空的父插件目录（cache/{marketplace}/{plugin}）
    // 版本化路径结构为：cache/{marketplace}/{plugin}/{version}
    const cachePath = getPluginCachePath()
    if (installPath.includes('/cache/') && installPath.startsWith(cachePath)) {
      const pluginDir = dirname(installPath) // e.g., cache/{marketplace}/{plugin}
      if (pluginDir !== cachePath && pluginDir.startsWith(cachePath)) {
        try {
          const contents = fs.readdirSync(pluginDir)
          if (contents.length === 0) {
            fs.rmdirSync(pluginDir)
            logForDebugging(`Deleted empty plugin directory at ${pluginDir}`)
          }
        } catch {
          // 父目录不存在或不可读，跳过清理
        }
      }
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logError(toError(error))
    throw new Error(`Failed to delete plugin cache at ${installPath}: ${errorMsg}`)
  }
}

/**
 * 从 git 仓库目录获取提交 SHA。
 * 不是 git 仓库或操作失败时返回 undefined。
 */
async function getGitCommitSha(dirPath: string): Promise<string | undefined> {
  const sha = await getHeadForDir(dirPath)
  return sha ?? undefined
}

/**
 * 尝试从插件 manifest 读取版本。
 */
function getPluginVersionFromManifest(pluginCachePath: string, pluginId: string): string {
  const fs = getFsImplementation()
  const manifestPath = join(pluginCachePath, '.zy-plugin', 'plugin.json')

  try {
    const manifestContent = fs.readFileSync(manifestPath, { encoding: 'utf-8' })
    const manifest = jsonParse(manifestContent)
    return manifest.version || 'unknown'
  } catch {
    logForDebugging(`Could not read version from manifest for ${pluginId}`)
    return 'unknown'
  }
}

/**
 * 将 installed_plugins.json 与设置中的 enabledPlugins 同步。
 *
 * 检查 schema 版本，仅在以下情况更新：
 * - 文件不存在（版本 0 → 当前版本）
 * - schema 版本已过期（旧版本 → 当前版本）
 * - enabledPlugins 中出现新插件
 *
 * 基于版本的方法便于未来添加新字段：
 * 1. 递增 CURRENT_SCHEMA_VERSION
 * 2. 为新版本添加迁移逻辑
 * 3. 下次启动时自动更新文件
 *
 * 对 enabledPlugins 中不在 installed_plugins.json 的每个插件：
 * - 查询 marketplace 以获取实际安装路径
 * - 如果可用，从 manifest 提取版本
 * - 为基于 git 的插件捕获提交 SHA
 *
 * 出现在 enabledPlugins 中（无论为 true 或 false）表示插件已经安装。
 * 启用/禁用状态仍保留在 settings.json 中。
 */
export async function migrateFromEnabledPlugins(): Promise<void> {
  // 使用合并后的设置进行 shouldSkipSync 检查
  const settings = getInitialSettings()
  const enabledPlugins = settings.enabledPlugins || {}

  // 设置中没有插件，无需同步
  if (Object.keys(enabledPlugins).length === 0) {
    return
  }

  // 检查主文件是否存在且为 V2 格式
  const rawFileData = readInstalledPluginsFileRaw()
  const fileExists = rawFileData !== null
  const isV2Format = fileExists && rawFileData?.version === 2

  // 如果文件存在且为 V2 格式，检查能否跳过昂贵的迁移
  if (isV2Format && rawFileData) {
    // 检查设置中的所有插件是否均已存在
    // （昂贵的 getPluginById/getGitCommitSha 只针对缺失插件运行）
    const existingData = InstalledPluginsFileSchemaV2().safeParse(rawFileData.data)

    if (existingData?.success) {
      const plugins = existingData.data.plugins
      const allPluginsExist = Object.keys(enabledPlugins)
        .filter((id) => id.includes('@'))
        .every((id) => {
          const installations = plugins[id]
          return installations && installations.length > 0
        })

      if (allPluginsExist) {
        logForDebugging('All plugins already exist, skipping migration')
        return
      }
    }
  }

  logForDebugging(
    fileExists
      ? 'Syncing installed_plugins.json with enabledPlugins from all settings.json files'
      : 'Creating installed_plugins.json from settings.json files',
  )

  const now = new Date().toISOString()
  const projectPath = getCwd()

  // 第 1 步：从所有 settings.json 文件构建 pluginId -> scope 映射
  // Settings.json 是作用域的事实来源
  const pluginScopeFromSettings = new Map<
    string,
    {
      scope: 'user' | 'project' | 'local'
      projectPath: string | undefined
    }
  >()

  // 遍历每个可编辑设置来源（顺序重要：user 在前）
  const settingSources: EditableSettingSource[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]

  for (const source of settingSources) {
    const sourceSettings = getSettingsForSource(source)
    const sourceEnabledPlugins = sourceSettings?.enabledPlugins || {}

    for (const pluginId of Object.keys(sourceEnabledPlugins)) {
      // 跳过非标准插件 ID
      if (!pluginId.includes('@')) {
        continue
      }

      // Settings.json 是事实来源，始终更新作用域
      // 使用最具体作用域（最后一个胜出：local > project > user）
      const scope = settingSourceToScope(source)
      pluginScopeFromSettings.set(pluginId, {
        scope,
        projectPath: scope === 'user' ? undefined : projectPath,
      })
    }
  }

  // 第 2 步：从现有数据开始（文件不存在则从空数据开始）
  let pluginsMap: InstalledPluginsMap = {}

  if (fileExists) {
    // 文件存在，加载现有数据
    const existingData = loadInstalledPlugins()
    pluginsMap = { ...existingData.plugins }
  }

  // 第 3 步：根据 settings.json 更新 V2 作用域（设置是事实来源）
  let updatedCount = 0
  let addedCount = 0

  for (const [pluginId, scopeInfo] of pluginScopeFromSettings) {
    const existingInstallations = pluginsMap[pluginId]

    if (existingInstallations && existingInstallations.length > 0) {
      // 插件存在于 V2 中：如果作用域不同则更新（设置是事实来源）
      const existingEntry = existingInstallations[0]
      if (
        existingEntry &&
        (existingEntry.scope !== scopeInfo.scope ||
          existingEntry.projectPath !== scopeInfo.projectPath)
      ) {
        existingEntry.scope = scopeInfo.scope
        if (scopeInfo.projectPath) {
          existingEntry.projectPath = scopeInfo.projectPath
        } else {
          delete existingEntry.projectPath
        }
        existingEntry.lastUpdated = now
        updatedCount++
        logForDebugging(
          `Updated ${pluginId} scope to ${scopeInfo.scope} (settings.json is source of truth)`,
        )
      }
    } else {
      // 插件不在 V2 中：尝试通过查询 marketplace 添加它
      const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)

      if (!pluginName || !marketplace) {
        continue
      }

      try {
        logForDebugging(`Looking up plugin ${pluginId} in marketplace ${marketplace}`)
        const pluginInfo = await getPluginById(pluginId)
        if (!pluginInfo) {
          logForDebugging(`Plugin ${pluginId} not found in any marketplace, skipping`)
          continue
        }

        const { entry, marketplaceInstallLocation } = pluginInfo

        let installPath: string
        let version = 'unknown'
        let gitCommitSha: string | undefined

        if (typeof entry.source === 'string') {
          installPath = join(marketplaceInstallLocation, entry.source)
          version = getPluginVersionFromManifest(installPath, pluginId)
          gitCommitSha = await getGitCommitSha(installPath)
        } else {
          const cachePath = getPluginCachePath()
          const sanitizedName = pluginName.replace(/[^a-zA-Z0-9-_]/g, '-')
          const pluginCachePath = join(cachePath, sanitizedName)

          // 直接读取缓存目录：readdir 是第一个实际操作，而非预检查。它的 ENOENT
          // 表明缓存不存在；其结果决定是否进行下方的 manifest 读取。这不是 TOCTOU，
          // 下游操作会妥善处理 ENOENT，因此竞争情况（在 readdir 和 read 之间删除
          // 目录）只会降级为 version='unknown'，而不会崩溃。
          let dirEntries: string[]
          try {
            dirEntries = (await getFsImplementation().readdir(pluginCachePath)).map((e) =>
              typeof e === 'string' ? e : e.name,
            )
          } catch (e) {
            if (!isENOENT(e)) {
              throw e
            }
            logForDebugging(`External plugin ${pluginId} not in cache, skipping`)
            continue
          }

          installPath = pluginCachePath

          // 仅在 .zy-plugin 目录存在时读取 manifest
          if (dirEntries.includes('.zy-plugin')) {
            version = getPluginVersionFromManifest(pluginCachePath, pluginId)
          }

          gitCommitSha = await getGitCommitSha(pluginCachePath)
        }

        if (version === 'unknown' && entry.version) {
          version = entry.version
        }
        if (version === 'unknown' && gitCommitSha) {
          version = gitCommitSha.substring(0, 12)
        }

        pluginsMap[pluginId] = [
          {
            scope: scopeInfo.scope,
            installPath: getVersionedCachePath(pluginId, version),
            version,
            installedAt: now,
            lastUpdated: now,
            gitCommitSha,
            ...(scopeInfo.projectPath && {
              projectPath: scopeInfo.projectPath,
            }),
          },
        ]

        addedCount++
        logForDebugging(`Added ${pluginId} with scope ${scopeInfo.scope}`)
      } catch (error) {
        logForDebugging(`Failed to add plugin ${pluginId}: ${error}`)
      }
    }
  }

  // 第 4 步：保存到单个文件（V2 格式）
  if (!fileExists || updatedCount > 0 || addedCount > 0) {
    const v2Data: InstalledPluginsFileV2 = { version: 2, plugins: pluginsMap }
    saveInstalledPluginsV2(v2Data)
    logForDebugging(
      `Sync completed: ${addedCount} added, ${updatedCount} updated in installed_plugins.json`,
    )
  }
}
