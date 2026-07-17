import { readFileSync } from 'node:fs'
import chalk from 'chalk'
import {
  setAllowedSettingSources,
  setFlagSettingsPath,
} from 'src/bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { eagerParseCliFlag } from '../../utils/cliArgs.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { getFsImplementation, safeResolvePath } from '../../utils/fsOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { parseSettingSourcesFlag } from '../../services/settings/constants.js'
import {
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
} from '../../services/settings/settings.js'
import { resetSettingsCache } from '../../services/settings/settingsCache.js'
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../services/telemetry/startupProfiler.js'
import { generateTempFilePath } from '../../utils/tempfile.js'
/**
 * 将托管设置键记录到 Statsig 用于分析。
 * 在 init() 完成后调用，以确保在模型解析之前
 * 设置已加载且环境变量已应用。
 */
export function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings')
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings)
      logEvent('zy_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(
          ',',
        ) as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch {
    // 静默忽略错误 —— 这仅用于分析
  }
}

function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')
    let settingsPath: string
    if (looksLikeJson) {
      // 这是 JSON 字符串 —— 验证并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(chalk.red('错误：提供给 --settings 的 JSON 无效\n'))
        process.exit(1)
      }

      // 创建临时文件并写入 JSON。
      // 使用基于内容哈希的路径而非随机 UUID，以避免破坏
      // Anthropic API 提示缓存。settings 路径最终会出现在
      // Bash 工具的 sandbox denyWithinAllow 列表中，该列表是
      // 发送给 API 的工具描述的一部分。每个子进程使用随机 UUID
      // 会在每次 query() 调用时更改工具描述，使缓存前缀失效，
      // 导致 12 倍的输入 token 成本惩罚。
      // 内容哈希确保相同的设置在进程边界之间生成相同路径
      //（每个 SDK query() 都会生成一个新进程）。
      settingsPath = generateTempFilePath('zy-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      // 这是一个文件路径 —— 解析并通过尝试读取来验证
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(
        getFsImplementation(),
        settingsFile,
      )
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`错误：找不到设置文件：${resolvedSettingsPath}\n`))
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }
    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`处理设置时出错：${errorMessage(error)}\n`))
    process.exit(1)
  }
}

function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`处理 --setting-sources 时出错：${errorMessage(error)}\n`))
    process.exit(1)
  }
}

/**
 * 在 init() 之前早期解析并加载设置标志
 * 这确保从初始化开始就过滤设置
 */
export function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  // 早期解析 --settings 标志以确保在 init() 之前加载设置
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  // 早期解析 --setting-sources 标志以控制加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
  profileCheckpoint('eagerLoadSettings_end')
}
