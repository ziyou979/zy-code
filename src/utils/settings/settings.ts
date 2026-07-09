import { feature } from 'bun:bundle'
import { dirname, join, resolve } from 'node:path'
import mergeWith from 'lodash-es/mergeWith.js'
import { z } from 'zod/v4'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { setLanguage } from '../../i18n/languageStore.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getZyConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { clone, jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import { loadStatuslineConfig } from './statuslineConfig.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

/**
 * 根据当前平台获取托管配置文件的路径
 */
function getManagedSettingsFilePath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

/**
 * 加载基于文件的托管配置：managed-settings.json + managed-settings.d/*.json。
 *
 * managed-settings.json 最先合并（最低优先级/基础），然后 drop-in
 * 文件按字母顺序排序并叠加合并（更高优先级，后加载的文件覆盖前面的）。
 * 这与 systemd/sudoers drop-in 约定一致：基础文件提供默认值，
 * drop-in 进行自定义。不同团队可以各自发布独立的策略片段
 *（如 10-otel.json、20-security.json），无需协调编辑同一个管理员拥有的文件。
 *
 * 导出用于测试。
 */
export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []
  let merged: SettingsJson = {}
  let found = false

  const { settings, errors: baseErrors } = parseSettingsFile(getManagedSettingsFilePath())
  errors.push(...baseErrors)
  if (settings && Object.keys(settings).length > 0) {
    merged = mergeWith(merged, settings, settingsMergeCustomizer)
    found = true
  }

  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        (d) =>
          (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.json') && !d.name.startsWith('.'),
      )
      .map((d) => d.name)
      .sort()
    for (const name of entries) {
      const { settings, errors: fileErrors } = parseSettingsFile(join(dropInDir, name))
      errors.push(...fileErrors)
      if (settings && Object.keys(settings).length > 0) {
        merged = mergeWith(merged, settings, settingsMergeCustomizer)
        found = true
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logError(e)
    }
  }

  return { settings: found ? merged : null, errors }
}

/**
 * 检查哪些基于文件的托管配置源存在。
 * 用于 /status 显示 "(file)"、"(drop-ins)" 或 "(file + drop-ins)"。
 */
export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  const { settings: base } = parseSettingsFile(getManagedSettingsFilePath())
  const hasBase = !!base && Object.keys(base).length > 0

  let hasDropIns = false
  const dropInDir = getManagedSettingsDropInDir()
  try {
    hasDropIns = getFsImplementation()
      .readdirSync(dropInDir)
      .some(
        (d) =>
          (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.json') && !d.name.startsWith('.'),
      )
  } catch {
    // 目录不存在
  }

  return { hasBase, hasDropIns }
}

/**
 * 适当处理文件系统错误
 * @param error 要处理的错误
 * @param path 导致错误的文件路径
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
    logForDebugging(`Broken symlink or missing file encountered for settings.json at path: ${path}`)
  } else {
    logError(error)
  }
}

/**
 * 将配置文件解析为结构化格式
 * @param path 配置文件的路径
 * @param source 配置的来源（可选，用于错误报告）
 * @returns 解析后的配置数据和验证错误
 */
export function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // 克隆以防止调用方（如 getSettingsForSourceUncached 和
    // updateSettingsForSource 中的 mergeWith）修改缓存条目。
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path)
  setCachedParsedFile(path, result)
  // 首次返回也需要克隆 - 调用方可能在另一个调用方读取同一缓存条目之前进行修改。
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
    const content = readFileSync(resolvedPath)

    if (content.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSON(content, false)

    // 在 schema 验证之前过滤无效的权限规则，以防止一条错误规则
    // 导致整个配置文件被拒绝。
    const ruleWarnings = filterInvalidPermissionRules(data, path)

    const schema = SettingsSchema()
    const result = schema.safeParse(data)

    if (!result.success) {
      const errors = formatZodError(result.error, path)
      return { settings: null, errors: [...ruleWarnings, ...errors] }
    }

    return { settings: result.data, errors: ruleWarnings }
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * 获取给定配置源对应的文件根目录的绝对路径
 *（例如对于 $PROJ_DIR/.zy/settings.json，返回 $PROJ_DIR）
 * @param source 配置的来源
 * @returns 配置文件的根路径
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getZyConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * 根据协作模式获取用户配置文件名。
 * 协作模式下返回 'cowork_settings.json'，否则返回 'settings.json'。
 *
 * 优先级：
 * 1. 会话状态（通过 CLI 参数 --cowork 设置）
 * 2. 环境变量 ZY_CODE_USE_COWORK_PLUGINS
 * 3. 默认值：'settings.json'
 */
function getUserSettingsFilePath(): string {
  if (getUseCoworkPlugins() || isEnvTruthy(process.env.ZY_CODE_USE_COWORK_PLUGINS)) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}

export function getSettingsFilePathForSource(source: SettingSource): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(getSettingsRootPathForSource(source), getUserSettingsFilePath())
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'policySettings':
      return getManagedSettingsFilePath()
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return join('.zy', 'settings.json')
    case 'localSettings':
      return join('.zy', 'settings.local.json')
  }
}

export function getSettingsForSource(source: SettingSource): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) {
    return cached
  }
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

function getSettingsForSourceUncached(source: SettingSource): SettingsJson | null {
  // 对于 policySettings：第一个有内容的源生效（remote > HKLM/plist > file > HKCU）
  if (source === 'policySettings') {
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }

    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0) {
      return mdmResult.settings
    }

    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) {
      return fileSettings
    }

    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) {
      return hkcu.settings
    }

    return null
  }

  const settingsFilePath = getSettingsFilePathForSource(source)
  const { settings: fileSettings } = settingsFilePath
    ? parseSettingsFile(settingsFilePath)
    : { settings: null }

  // 对于 flagSettings，合并通过 SDK 设置的内联配置
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const parsed = SettingsSchema().safeParse(inlineSettings)
      if (parsed.success) {
        return mergeWith(fileSettings || {}, parsed.data, settingsMergeCustomizer) as SettingsJson
      }
    }
  }

  return fileSettings
}

/**
 * 获取最高优先级的活跃策略配置源的来源。
 * 使用"第一个有内容的源生效"策略 - 返回第一个有内容的源。
 * 优先级：remote > plist/hklm > file (managed-settings.json) > hkcu
 */
export function getPolicySettingsOrigin(): 'remote' | 'plist' | 'hklm' | 'file' | 'hkcu' | null {
  // 1. 远程（最高优先级）
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return 'remote'
  }

  // 2. 仅管理员的 MDM（HKLM / macOS plist）
  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return getPlatform() === 'macos' ? 'plist' : 'hklm'
  }

  // 3. managed-settings.json + managed-settings.d/（基于文件，需要管理员权限）
  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return 'file'
  }

  // 4. HKCU（最低优先级 - 用户可写）
  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return 'hkcu'
  }

  return null
}

/**
 * 使用 lodash mergeWith 将 `settings` 合并到 `source` 的现有配置中。
 *
 * 要从 record 字段（如 enabledPlugins、extraKnownMarketplaces）中删除一个键，
 * 请将其设置为 `undefined` - 不要使用 `delete`。mergeWith 只有在键存在且
 * 值为显式 `undefined` 时才能检测到删除操作。
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if ((source as unknown) === 'policySettings' || (source as unknown) === 'flagSettings') {
    return { error: null }
  }

  // 如果需要则创建文件夹
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    getFsImplementation().mkdirSync(dirname(filePath))

    // 尝试获取带验证的现有配置。绕过按源缓存 -
    // 下面的 mergeWith 会修改其目标对象（包括嵌套引用），
    // 如果写入在 resetSettingsCache() 之前失败，修改缓存对象会泄露未持久化的状态。
    let existingSettings = getSettingsForSourceUncached(source)

    // 如果验证失败，检查文件是否存在 JSON 语法错误
    if (!existingSettings) {
      let content: string | null = null
      try {
        content = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // 文件不存在 - 继续与空配置合并
      }
      if (content !== null) {
        const rawData = safeParseJSON(content)
        if (rawData === null) {
          // JSON 语法错误 - 返回验证错误而不是覆盖
          // safeParseJSON 已经记录了错误，所以这里直接返回错误
          return {
            error: new Error(`Invalid JSON syntax in settings file at ${filePath}`),
          }
        }
        if (rawData && typeof rawData === 'object') {
          existingSettings = rawData as SettingsJson
          logForDebugging(`Using raw settings from ${filePath} due to validation failure`)
        }
      }
    }

    const updatedSettings = mergeWith(
      existingSettings || {},
      settings,
      (
        _objValue: unknown,
        srcValue: unknown,
        key: string | number | symbol,
        object: Record<string | number | symbol, unknown>,
      ) => {
        // 将 undefined 视为删除操作
        if (srcValue === undefined && object && typeof key === 'string') {
          delete object[key]
          return undefined
        }
        // 对于数组，始终使用提供的数组替换
        // 由调用方负责计算所需的最终状态
        if (Array.isArray(srcValue)) {
          return srcValue
        }
        // 对于非数组值，让 lodash 处理默认的合并行为
        return undefined
      },
    )

    // 在写入文件之前标记为内部写入
    markInternalWrite(filePath)

    writeFileSyncAndFlush_DEPRECATED(filePath, `${jsonStringify(updatedSettings, null, 2)}\n`)

    // 配置已更新，使会话缓存失效
    resetSettingsCache()

    if (source === 'localSettings') {
      // 可以异步添加到 gitignore，无需等待
      void addFileGlobRuleToGitignore(
        getRelativeSettingsFilePathForSource('localSettings'),
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(`Failed to read raw settings from ${filePath}: ${e}`)
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * 数组的自定义合并函数 - 拼接并去重
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * 合并配置时用于 lodash mergeWith 的自定义合并函数。
 * 数组会被拼接并去重；其他值使用 lodash 默认的合并行为。
 * 导出用于测试。
 */
export function settingsMergeCustomizer(objValue: unknown, srcValue: unknown): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  // 返回 undefined 让 lodash 处理默认的合并行为
  return undefined
}

/**
 * 获取托管配置的键列表，用于日志记录。
 * 对于某些嵌套配置（permissions、sandbox、hooks），会展开一层嵌套
 *（如 "permissions.allow"）。对于其他配置，只返回顶级键。
 *
 * @param settings 要提取键的配置对象
 * @returns 排序后的键路径数组
 */
export function getManagedSettingsKeysForLogging(settings: SettingsJson): string[] {
  // 使用 .strip() 只获取有效的 schema 键
  const validSettings = SettingsSchema().strip().parse(settings) as Record<string, unknown>
  const keysToExpand = ['permissions', 'sandbox', 'hooks']
  const allKeys: string[] = []

  // 定义每个需要展开的嵌套配置的有效嵌套键
  const validNestedKeys: Record<string, Set<string>> = {
    permissions: new Set([
      'allow',
      'deny',
      'ask',
      'defaultMode',
      'disableBypassPermissionsMode',
      'disableAutoMode',
      'additionalDirectories',
    ]),
    sandbox: new Set([
      'enabled',
      'failIfUnavailable',
      'allowUnsandboxedCommands',
      'network',
      'filesystem',
      'ignoreViolations',
      'excludedCommands',
      'autoAllowBashIfSandboxed',
      'enableWeakerNestedSandbox',
      'enableWeakerNetworkIsolation',
      'ripgrep',
    ]),
    // 对于 hooks，使用 z.record 配合枚举键，所以单独验证
    hooks: new Set([
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
    ]),
  }

  for (const key of Object.keys(validSettings)) {
    if (
      keysToExpand.includes(key) &&
      validSettings[key] &&
      typeof validSettings[key] === 'object'
    ) {
      // 展开这些特殊配置的嵌套键（仅一层深度）
      const nestedObj = validSettings[key] as Record<string, unknown>
      const validKeys = validNestedKeys[key]

      if (validKeys) {
        for (const nestedKey of Object.keys(nestedObj)) {
          // 只包含已知的有效嵌套键
          if (validKeys.has(nestedKey)) {
            allKeys.push(`${key}.${nestedKey}`)
          }
        }
      }
    } else {
      // 对于其他配置，只使用顶级键
      allKeys.push(key)
    }
  }

  return allKeys.sort()
}

// 防止加载配置时无限递归的标志
let isLoadingSettings = false

/**
 * 从磁盘加载配置，不使用缓存。
 * 这是实际从文件读取的原始实现。
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // 防止递归调用 loadSettingsFromDisk
  if (isLoadingSettings) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  isLoadingSettings = true
  try {
    // 以插件配置作为最低优先级的基础。
    // 所有基于文件的源（user、project、local、flag、policy）都会覆盖这些。
    // 插件配置只包含白名单中的键（如 agent），它们是有效的 SettingsJson 字段。
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(mergedSettings, pluginSettings, settingsMergeCustomizer)
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()

    // 按优先级顺序深度合并各源的配置
    for (const source of getEnabledSettingSources()) {
      // policySettings："第一个有内容的源生效" - 使用最高优先级的源。
      // 优先级：remote > HKLM/plist > managed-settings.json > HKCU
      if (source === 'policySettings') {
        let policySettings: SettingsJson | null = null
        const policyErrors: ValidationError[] = []

        // 1. 远程（最高优先级）
        const remoteSettings = getRemoteManagedSettingsSyncFromCache()
        if (remoteSettings && Object.keys(remoteSettings).length > 0) {
          const result = SettingsSchema().safeParse(remoteSettings)
          if (result.success) {
            policySettings = result.data
          } else {
            // 远程配置存在但无效 - 即使继续回退也要暴露错误
            policyErrors.push(...formatZodError(result.error, 'remote managed settings'))
          }
        }

        // 2. 仅管理员的 MDM（HKLM / macOS plist）
        if (!policySettings) {
          const mdmResult = getMdmSettings()
          if (Object.keys(mdmResult.settings).length > 0) {
            policySettings = mdmResult.settings
          }
          policyErrors.push(...mdmResult.errors)
        }

        // 3. managed-settings.json + managed-settings.d/（基于文件，需要管理员权限）
        if (!policySettings) {
          const { settings, errors } = loadManagedFileSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 4. HKCU（最低优先级 - 用户可写，仅在以上源都不存在时使用）
        if (!policySettings) {
          const hkcu = getHkcuSettings()
          if (Object.keys(hkcu.settings).length > 0) {
            policySettings = hkcu.settings
          }
          policyErrors.push(...hkcu.errors)
        }

        // 将胜出的策略源合并到配置链中
        if (policySettings) {
          mergedSettings = mergeWith(mergedSettings, policySettings, settingsMergeCustomizer)
        }
        for (const error of policyErrors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        continue
      }

      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)

        // 如果已经从其他源加载过此文件则跳过
        if (!seenFiles.has(resolvedPath)) {
          seenFiles.add(resolvedPath)

          const { settings, errors } = parseSettingsFile(filePath)

          // 添加唯一的错误（去重）
          for (const error of errors) {
            const errorKey = `${error.file}:${error.path}:${error.message}`
            if (!seenErrors.has(errorKey)) {
              seenErrors.add(errorKey)
              allErrors.push(error)
            }
          }

          if (settings) {
            mergedSettings = mergeWith(mergedSettings, settings, settingsMergeCustomizer)
          }
        }
      }

      // 对于 flagSettings，还需要合并通过 SDK 设置的内联配置
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const parsed = SettingsSchema().safeParse(inlineSettings)
          if (parsed.success) {
            mergedSettings = mergeWith(mergedSettings, parsed.data, settingsMergeCustomizer)
          }
        }
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    // 加载 statusline.json（独立配置文件，最高优先级覆盖 builtInStatusBar）
    const statuslineConfig = loadStatuslineConfig()
    if (statuslineConfig) {
      mergedSettings = {
        ...mergedSettings,
        builtInStatusBar: {
          enabled: statuslineConfig.enabled,
          modules: statuslineConfig.modules,
        },
      }
    }

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    isLoadingSettings = false
  }
}

/**
 * 按优先级顺序从所有源获取合并后的配置。
 * 配置按从低到高的优先级合并：
 * userSettings -> projectSettings -> localSettings -> policySettings
 *
 * 此函数返回调用时配置的快照。
 * 对于 React 组件，建议使用 useSettings() hook 以在磁盘上的配置
 * 变更时获得响应式更新。
 *
 * 使用会话级缓存以避免重复的文件 I/O。
 * 当配置文件通过 resetSettingsCache() 变更时缓存会失效。
 *
 * @returns 所有可用源合并后的配置（始终返回至少空对象）
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

export type SettingsWithSources = {
  effective: SettingsJson
  /** 按从低到高的优先级排序 - 后面的条目覆盖前面的。 */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * 获取生效的合并配置以及每个源的原始配置，
 * 按合并优先级排序。仅包含已启用且有非空内容的源。
 *
 * 始终从磁盘重新读取 - 重置会话缓存以确保 `effective`
 * 和 `sources` 一致，即使变更检测器尚未触发。
 */
export function getSettingsWithSources(): SettingsWithSources {
  // 重置两个缓存，以确保 getSettingsForSource（按源缓存）和
  // getInitialSettings（会话缓存）对当前磁盘状态达成一致。
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * 从所有源获取合并后的配置和验证错误。
 * 此函数现在使用会话级缓存以避免重复的文件 I/O。
 * 配置变更需要重启 ZY Code，因此缓存在整个会话期间有效。
 * @returns 合并后的配置和所有遇到的验证错误
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  // 如果有可用的缓存结果则使用缓存
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  // 从磁盘加载并缓存结果
  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  // 把生效语言推入 i18n 语言状态叶子（断环：i18n 读 store，不反向依赖 settings）。
  // 命中缓存的快路径无需重推（设缓存时已推过）；resetSettingsCache 后的重载会再次经此推送，
  // 因此磁盘改动 / 变更检测触发的语言变化会自动同步。
  setLanguage(result.settings?.language)
  return result
}

/**
 * 检查任何原始配置文件是否包含特定键，不考虑验证结果。
 * 这对于检测用户意图很有用，即使配置验证失败。
 * 例如，如果用户设置了 cleanupPeriodDays 但其他地方有验证错误，
 * 我们可以检测到他们明确配置了清理策略并跳过清理，而不是回退到默认值。
 */
/**
 * 如果任何受信任的配置源已接受绕过权限模式对话框则返回 true。
 * projectSettings 被有意排除 - 恶意项目可能会自动绕过对话框（RCE 风险）。
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('policySettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * 如果任何受信任的配置源已接受自动模式选择加入对话框则返回 true。
 * projectSettings 被有意排除 - 恶意项目可能会自动绕过对话框（RCE 风险）。
 */
export function hasAutoModeOptIn(): boolean {
  const user = getSettingsForSource('userSettings')?.skipAutoPermissionPrompt
  const local = getSettingsForSource('localSettings')?.skipAutoPermissionPrompt
  const flag = getSettingsForSource('flagSettings')?.skipAutoPermissionPrompt
  const policy = getSettingsForSource('policySettings')?.skipAutoPermissionPrompt
  const result = !!(user || local || flag || policy)
  logForDebugging(
    `[auto-mode] hasAutoModeOptIn=${result} skipAutoPermissionPrompt: user=${user} local=${local} flag=${flag} policy=${policy}`,
  )
  return result
}

/**
 * 返回计划模式是否应使用自动模式语义。默认为 true（选择退出）。
 * 如果任何受信任源明确设置为 false 则返回 false。
 * projectSettings 被排除以防止恶意项目控制此行为。
 */
export function getUseAutoModeDuringPlan(): boolean {
  return (
    getSettingsForSource('policySettings')?.useAutoModeDuringPlan !== false &&
    getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
    getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
    getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
  )
}

/**
 * 返回从受信任配置源合并后的 autoMode 配置。
 * 仅在 TRANSCRIPT_CLASSIFIER 激活时可用；否则返回 undefined。
 * projectSettings 被有意排除 - 恶意项目可能会注入分类器
 * allow/deny 规则（RCE 风险）。
 */
export function getAutoModeConfig():
  | {
      allow?: string[]
      soft_deny?: string[]
      hard_deny?: string[]
      environment?: string[]
      /** 启用后，所有 shell 命令（PowerShell/cd/gh 等）都经过 auto mode 分类器 */
      classifyAllShell?: boolean
    }
  | undefined {
  const schema = z.object({
    allow: z.array(z.string()).optional(),
    soft_deny: z.array(z.string()).optional(),
    hard_deny: z.array(z.string()).optional(),
    // 兼容旧字段：deny 等同于 soft_deny
    deny: z.array(z.string()).optional(),
    environment: z.array(z.string()).optional(),
    classifyAllShell: z.boolean().optional(),
  })

  const allow: string[] = []
  const soft_deny: string[] = []
  const hard_deny: string[] = []
  const environment: string[] = []
  let classifyAllShell = false

  for (const source of [
    'userSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ] as const) {
    const settings = getSettingsForSource(source)
    if (!settings) {
      continue
    }
    const result = schema.safeParse((settings as Record<string, unknown>).autoMode)
    if (result.success) {
      if (result.data.allow) {
        allow.push(...result.data.allow)
      }
      if (result.data.soft_deny) {
        soft_deny.push(...result.data.soft_deny)
      }
      if (result.data.hard_deny) {
        hard_deny.push(...result.data.hard_deny)
      }
      // 兼容旧字段：将 deny 视为 soft_deny
      if (result.data.deny) {
        soft_deny.push(...result.data.deny)
      }
      if (result.data.environment) {
        environment.push(...result.data.environment)
      }
      // 任一配置源启用即视为全局开启
      if (result.data.classifyAllShell) {
        classifyAllShell = true
      }
    }
  }

  if (
    allow.length > 0 ||
    soft_deny.length > 0 ||
    hard_deny.length > 0 ||
    environment.length > 0 ||
    classifyAllShell
  ) {
    return {
      ...(allow.length > 0 && { allow }),
      ...(soft_deny.length > 0 && { soft_deny }),
      ...(hard_deny.length > 0 && { hard_deny }),
      ...(environment.length > 0 && { environment }),
      ...(classifyAllShell && { classifyAllShell: true }),
    }
  }
  return undefined
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    // 跳过 policySettings - 我们只关心用户配置的设置
    if (source === 'policySettings') {
      continue
    }

    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSON(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // 文件未找到是预期行为 - 并非所有配置文件都存在
      // 其他错误（权限、I/O）应被追踪
      handleFileSystemError(error, filePath)
    }
  }

  return false
}
