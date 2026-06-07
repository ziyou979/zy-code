/**
 * 远程托管设置服务
 *
 * 管理企业客户远程托管设置的获取、缓存和验证。使用基于校验和的验证
 * 来最小化网络流量，并在失败时提供优雅降级。
 *
 * 资格说明：
 * - 控制台用户（API 密钥）：全部符合
 * - OAuth 用户（Zy.ai）：仅限 Enterprise/C4E 和 Team 订阅用户
 * - API 失败时开放（非阻塞）— 如果获取失败，继续不使用远程设置
 * - API 对没有托管设置的用户返回空设置
 */

import { createHash } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getApiKeyWithSource,
  getZyAIOAuthTokens,
} from '../auth/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { classifyAxiosError, getErrnoCode } from '../../utils/errors.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { type SettingsJson, SettingsSchema } from '../../utils/settings/types.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getZyCodeUserAgent } from '../../utils/userAgent.js'
import { getRetryDelay } from '../api/withRetry.js'
import { checkManagedSettingsSecurity, handleSecurityCheckResult } from './securityCheck.jsx'
import { isRemoteManagedSettingsEligible, resetSyncCache } from './syncCache.js'
import {
  getRemoteManagedSettingsSyncFromCache,
  getSettingsPath,
  setSessionCache,
} from './syncCacheState.js'
import {
  type RemoteManagedSettingsFetchResult,
  RemoteManagedSettingsResponseSchema,
} from './types.js'

// 常量
const SETTINGS_TIMEOUT_MS = 10000 // 设置获取 10 秒超时
const DEFAULT_MAX_RETRIES = 5
const POLLING_INTERVAL_MS = 60 * 60 * 1000 // 1 小时

// 后台轮询状态
let pollingIntervalId: ReturnType<typeof setInterval> | null = null

// 解析远程设置加载完成的 Promise
// 这允许其他系统在初始化之前等待远程设置加载
let loadingCompletePromise: Promise<void> | null = null
let loadingCompleteResolve: (() => void) | null = null

// 加载 Promise 的超时，防止在未调用 loadRemoteManagedSettings() 时死锁
// （例如在不经由 main.tsx 的 Agent SDK 测试中）
const LOADING_PROMISE_TIMEOUT_MS = 30000 // 30 秒

/**
 * 初始化远程托管设置的加载 Promise
 * 应该在早期调用（例如在 init.ts 中），以允许其他系统
 * 等待远程设置加载，即使尚未调用 loadRemoteManagedSettings()。
 *
 * 仅在用户符合远程设置资格时创建 Promise。
 * 包含超时以防止在从未调用 loadRemoteManagedSettings() 时死锁。
 */
export function initializeRemoteManagedSettingsLoadingPromise(): void {
  if (loadingCompletePromise) {
    return
  }

  if (isRemoteManagedSettingsEligible()) {
    loadingCompletePromise = new Promise((resolve) => {
      loadingCompleteResolve = resolve

      // 设置超时，即使从未调用 loadRemoteManagedSettings() 也解析 Promise
      // 这防止了 Agent SDK 测试和其他非 CLI 上下文中的死锁
      setTimeout(() => {
        if (loadingCompleteResolve) {
          logForDebugging('Remote settings: Loading promise timed out, resolving anyway')
          loadingCompleteResolve()
          loadingCompleteResolve = null
        }
      }, LOADING_PROMISE_TIMEOUT_MS)
    })
  }
}

/**
 * 获取远程设置 API 端点
 * 使用 OAuth 配置的基础 API URL
 */
function getRemoteManagedSettingsEndpoint() {
  return `${getOauthConfig().BASE_API_URL}/api/claude_code/settings`
}

/**
 * 递归排序对象中的所有键，以匹配 Python 的 json.dumps(sort_keys=True)
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep)
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key])
    }
    return sorted
  }
  return obj
}

/**
 * 从设置内容计算校验和，用于 HTTP 缓存
 * 必须与服务器的 Python 匹配：json.dumps(settings, sort_keys=True, separators=(",", ":"))
 * 导出用于测试，以验证与服务器端实现的兼容性
 */
export function computeChecksumFromSettings(settings: SettingsJson): string {
  const sorted = sortKeysDeep(settings)
  // 分隔符后无空格以匹配 Python 的 separators=(",", ":")
  const normalized = jsonStringify(sorted)
  const hash = createHash('sha256').update(normalized).digest('hex')
  return `sha256:${hash}`
}

/**
 * 检查当前用户是否有资格使用远程托管设置
 * 这是其他系统检查资格的公共 API
 * 用于确定是否应该等待远程设置加载
 */
export function isEligibleForRemoteManagedSettings(): boolean {
  return isRemoteManagedSettingsEligible()
}

/**
 * 等待初始远程设置加载完成
 * 在以下情况立即返回：
 * - 用户不符合远程设置资格
 * - 加载已完成
 * - 加载从未开始
 */
export async function waitForRemoteManagedSettingsToLoad(): Promise<void> {
  if (loadingCompletePromise) {
    await loadingCompletePromise
  }
}

/**
 * 获取远程设置的认证头，不调用 getSettings()
 * 这避免了设置加载期间的循环依赖
 * 支持 API 密钥和 OAuth 认证
 */
function getRemoteSettingsAuthHeaders(): {
  headers: Record<string, string>
  error?: string
} {
  // 先尝试 API 密钥（适用于控制台用户）
  // 跳过 apiKeyHelper 以避免与 getSettings() 的循环依赖
  // 用 try-catch 包装，因为 getApiKeyWithSource 在 CI/测试环境中会抛出异常
  try {
    const { key: apiKey } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return {
        headers: {
          'x-api-key': apiKey,
        },
      }
    }
  } catch {
    // 无 API 密钥可用 - 继续检查 OAuth
  }

  // 回退到 OAuth 令牌（适用于 Zy.ai 用户）
  const oauthTokens = getZyAIOAuthTokens()
  if (oauthTokens?.accessToken) {
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }

  return {
    headers: {},
    error: 'No authentication available',
  }
}

/**
 * 使用重试逻辑和指数退避获取远程设置
 * 使用现有的代码库重试工具以保持一致性
 */
async function fetchWithRetry(cachedChecksum?: string): Promise<RemoteManagedSettingsFetchResult> {
  let lastResult: RemoteManagedSettingsFetchResult | null = null

  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
    lastResult = await fetchRemoteManagedSettings(cachedChecksum)

    // 成功立即返回
    if (lastResult.success) {
      return lastResult
    }

    // 如果错误不可重试，则不重试（例如认证错误）
    if (lastResult.skipRetry) {
      return lastResult
    }

    // 如果已耗尽重试次数，返回最后一个错误
    if (attempt > DEFAULT_MAX_RETRIES) {
      return lastResult
    }

    // 计算延迟并在下次重试前等待
    const delayMs = getRetryDelay(attempt)
    logForDebugging(`Remote settings: Retry ${attempt}/${DEFAULT_MAX_RETRIES} after ${delayMs}ms`)
    await sleep(delayMs)
  }

  // 绝不应到达这里，但 TypeScript 需要它
  return lastResult!
}

/**
 * 获取完整的远程设置（单次尝试，无重试）
 * 可选择传入缓存的校验和用于 ETag 缓存
 */
async function fetchRemoteManagedSettings(
  cachedChecksum?: string,
): Promise<RemoteManagedSettingsFetchResult> {
  try {
    // 获取设置前确保 OAuth 令牌是最新的
    // 这防止了因过期缓存令牌导致的 401 错误
    await checkAndRefreshOAuthTokenIfNeeded()

    // 使用本地认证头获取器以避免与 getSettings() 的循环依赖
    const authHeaders = getRemoteSettingsAuthHeaders()
    if (authHeaders.error) {
      // 认证错误不应重试 — 返回特殊标志以跳过重试
      return {
        success: false,
        error: `Authentication required for remote settings`,
        skipRetry: true,
      }
    }

    const endpoint = getRemoteManagedSettingsEndpoint()
    const headers: Record<string, string> = {
      ...authHeaders.headers,
      'User-Agent': getZyCodeUserAgent(),
    }

    // 为基于 ETag 的缓存添加 If-None-Match 头
    if (cachedChecksum) {
      headers['If-None-Match'] = `"${cachedChecksum}"`
    }

    const response = await axios.get(endpoint, {
      headers,
      timeout: SETTINGS_TIMEOUT_MS,
      // 允许 204、304 和 404 响应，不将其视为错误。
      // 当用户没有设置或功能标志关闭时返回 204/404。
      validateStatus: (status) =>
        status === 200 || status === 204 || status === 304 || status === 404,
    })

    // 处理 304 Not Modified — 缓存版本仍然有效
    if (response.status === 304) {
      logForDebugging('Remote settings: Using cached settings (304)')
      return {
        success: true,
        settings: null, // 信号缓存有效
        checksum: cachedChecksum,
      }
    }

    // 处理 204 No Content / 404 Not Found — 没有设置或功能标志关闭。
    // 返回空对象（不是 null），以便调用者不会回退到缓存的设置。
    if (response.status === 204 || response.status === 404) {
      logForDebugging(`Remote settings: No settings found (${response.status})`)
      return {
        success: true,
        settings: {},
        checksum: undefined,
      }
    }

    const parsed = RemoteManagedSettingsResponseSchema().safeParse(response.data)
    if (!parsed.success) {
      logForDebugging(`Remote settings: Invalid response format - ${parsed.error.message}`)
      return {
        success: false,
        error: 'Invalid remote settings format',
      }
    }

    // 完整验证设置结构
    const settingsValidation = SettingsSchema().safeParse(parsed.data.settings)
    if (!settingsValidation.success) {
      logForDebugging(
        `Remote settings: Settings validation failed - ${settingsValidation.error.message}`,
      )
      return {
        success: false,
        error: 'Invalid settings structure',
      }
    }

    logForDebugging('Remote settings: Fetched successfully')
    return {
      success: true,
      settings: settingsValidation.data,
      checksum: parsed.data.checksum,
    }
  } catch (error) {
    const { kind, status, message } = classifyAxiosError(error)
    if (status === 404) {
      // 404 表示没有配置远程设置
      return { success: true, settings: {}, checksum: '' }
    }
    switch (kind) {
      case 'auth':
        // 认证错误（401、403）不应重试 — API 密钥没有访问权限
        return {
          success: false,
          error: 'Not authorized for remote settings',
          skipRetry: true,
        }
      case 'timeout':
        return { success: false, error: 'Remote settings request timeout' }
      case 'network':
        return { success: false, error: 'Cannot connect to server' }
      default:
        return { success: false, error: message }
    }
  }
}

/**
 * 保存远程设置到文件
 * 存储原始设置 JSON（校验和在需要时按需计算）
 */
async function saveSettings(settings: SettingsJson): Promise<void> {
  try {
    const path = getSettingsPath()
    const handle = await open(path, 'w', 0o600)
    try {
      await handle.writeFile(jsonStringify(settings, null, 2), {
        encoding: 'utf-8',
      })
      await handle.datasync()
    } finally {
      await handle.close()
    }
    logForDebugging(`Remote settings: Saved to ${path}`)
  } catch (error) {
    logForDebugging(
      `Remote settings: Failed to save - ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    // 忽略保存错误 — 下次启动时重新获取
  }
}

/**
 * 清除所有远程设置（会话、持久化和停止轮询）
 */
export async function clearRemoteManagedSettingsCache(): Promise<void> {
  // 停止后台轮询
  stopBackgroundPolling()

  // 清除会话缓存
  resetSyncCache()

  // 清除加载 Promise 状态
  loadingCompletePromise = null
  loadingCompleteResolve = null

  try {
    const path = getSettingsPath()
    await unlink(path)
  } catch {
    // 清除文件时忽略错误（预期会出现 ENOENT）
  }
}

/**
 * 使用文件缓存获取和加载远程设置
 * 内部函数，处理完整的加载/获取逻辑
 * 失败时开放 — 如果获取失败且不存在缓存则返回 null
 */
async function fetchAndLoadRemoteManagedSettings(): Promise<SettingsJson | null> {
  if (!isRemoteManagedSettingsEligible()) {
    return null
  }

  // 从文件加载缓存的设置
  const cachedSettings = getRemoteManagedSettingsSyncFromCache()

  // 从缓存的设置本地计算校验和，用于 HTTP 缓存验证
  const cachedChecksum = cachedSettings ? computeChecksumFromSettings(cachedSettings) : undefined

  try {
    // 使用重试逻辑从 API 获取设置
    const result = await fetchWithRetry(cachedChecksum)

    if (!result.success) {
      // 获取失败时，如果有文件则使用过期的文件（优雅降级）
      if (cachedSettings) {
        logForDebugging('Remote settings: Using stale cache after fetch failure')
        setSessionCache(cachedSettings)
        return cachedSettings
      }
      // 无可用缓存 — 失败时开放，继续不使用远程设置
      return null
    }

    // 处理 304 Not Modified — 缓存的设置仍然有效
    if (result.settings === null && cachedSettings) {
      logForDebugging('Remote settings: Cache still valid (304 Not Modified)')
      setSessionCache(cachedSettings)
      return cachedSettings
    }

    // 保存新设置到文件（仅当非空时）
    const newSettings = result.settings || {}
    const hasContent = Object.keys(newSettings).length > 0

    if (hasContent) {
      // 应用前检查危险设置变更
      const securityResult = await checkManagedSettingsSecurity(cachedSettings, newSettings)
      if (!handleSecurityCheckResult(securityResult)) {
        // 用户拒绝 — 不应用设置，返回缓存或 null
        logForDebugging('Remote settings: User rejected new settings, using cached settings')
        return cachedSettings
      }

      setSessionCache(newSettings)
      await saveSettings(newSettings)
      logForDebugging('Remote settings: Applied new settings successfully')
      return newSettings
    }

    // 空设置（404 响应）— 如果存在则删除缓存文件
    // 这确保当用户的远程设置被移除时，过期的设置不会持续存在
    setSessionCache(newSettings)
    try {
      const path = getSettingsPath()
      await unlink(path)
      logForDebugging('Remote settings: Deleted cached file (404 response)')
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(
          `Remote settings: Failed to delete cached file - ${e instanceof Error ? e.message : 'unknown error'}`,
        )
      }
    }
    return newSettings
  } catch {
    // 发生任何错误时，如果有过期文件则使用它（优雅降级）
    if (cachedSettings) {
      logForDebugging('Remote settings: Using stale cache after error')
      setSessionCache(cachedSettings)
      return cachedSettings
    }

    // No cache available - fail open, continue without remote settings
    return null
  }
}

/**
 * 在 CLI 初始化期间加载远程设置
 * 失败时开放 — 如果获取失败，继续不使用远程设置
 * 同时启动后台轮询以在会话中途获取设置变更
 *
 * 此函数设置一个 Promise，其他系统可以通过
 * waitForRemoteManagedSettingsToLoad() 等待，以确保它们在
 * 远程设置获取完成之前不会初始化。
 */
export async function loadRemoteManagedSettings(): Promise<void> {
  // 为其他系统设置等待的 Promise
  // 仅在用户符合远程设置资格且 Promise 尚未设置时
  // （initializeRemoteManagedSettingsLoadingPromise 可能已经被提前调用）
  if (isRemoteManagedSettingsEligible() && !loadingCompletePromise) {
    loadingCompletePromise = new Promise((resolve) => {
      loadingCompleteResolve = resolve
    })
  }

  // 缓存优先：如果磁盘上有缓存的设置，立即应用并解除
  // 等待者的阻塞。获取仍在下面运行；notifyChange 像以前一样
  // 在获取后触发一次。节省打印模式启动时约 77ms 的获取等待。
  // getRemoteManagedSettingsSyncFromCache 有资格守卫并在内部
  // 填充会话缓存 — 这里不需要调用 setSessionCache。
  if (getRemoteManagedSettingsSyncFromCache() && loadingCompleteResolve) {
    loadingCompleteResolve()
    loadingCompleteResolve = null
  }

  try {
    const settings = await fetchAndLoadRemoteManagedSettings()

    // 启动后台轮询以在会话中途获取设置变更
    if (isRemoteManagedSettingsEligible()) {
      startBackgroundPolling()
    }

    // 如果加载了设置（新的或来自缓存），触发热重载。
    // notifyChange 在遍历监听器之前在内部重置设置缓存 —
    // 环境变量、遥测和权限在下次读取时更新。
    if (settings !== null) {
      settingsChangeDetector.notifyChange('policySettings')
    }
  } finally {
    // 始终解析 Promise，即使获取失败（失败时开放）
    if (loadingCompleteResolve) {
      loadingCompleteResolve()
      loadingCompleteResolve = null
    }
  }
}

/**
 * 异步刷新远程设置（用于认证状态变更）
 * 在登录/注销时使用
 * 失败时开放 — 如果获取失败，继续不使用远程设置
 */
export async function refreshRemoteManagedSettings(): Promise<void> {
  // 先清除缓存
  await clearRemoteManagedSettingsCache()

  // 如果未启用，通知策略设置已变更（变为空）
  if (!isRemoteManagedSettingsEligible()) {
    settingsChangeDetector.notifyChange('policySettings')
    return
  }

  // 尝试加载新设置（如果获取失败则失败时开放）
  await fetchAndLoadRemoteManagedSettings()
  logForDebugging('Remote settings: Refreshed after auth change')

  // 通知监听器。notifyChange 在内部重置设置缓存；
  // 这触发热重载（AppState 更新、环境变量应用等）
  settingsChangeDetector.notifyChange('policySettings')
}

/**
 * 后台轮询回调 — 获取设置并在变更时触发热重载
 */
async function pollRemoteSettings(): Promise<void> {
  if (!isRemoteManagedSettingsEligible()) {
    return
  }

  // 获取当前缓存的设置以进行比较
  const prevCache = getRemoteManagedSettingsSyncFromCache()
  const previousSettings = prevCache ? jsonStringify(prevCache) : null

  try {
    await fetchAndLoadRemoteManagedSettings()

    // 检查设置是否实际变更
    const newCache = getRemoteManagedSettingsSyncFromCache()
    const newSettings = newCache ? jsonStringify(newCache) : null
    if (newSettings !== previousSettings) {
      logForDebugging('Remote settings: Changed during background poll')
      settingsChangeDetector.notifyChange('policySettings')
    }
  } catch {
    // 后台轮询不要失败时关闭 — 只需继续
  }
}

/**
 * 启动远程设置的后台轮询
 * 每小时轮询一次以获取会话中途的设置变更
 */
export function startBackgroundPolling(): void {
  if (pollingIntervalId !== null) {
    return
  }

  if (!isRemoteManagedSettingsEligible()) {
    return
  }

  pollingIntervalId = setInterval(() => {
    void pollRemoteSettings()
  }, POLLING_INTERVAL_MS)
  pollingIntervalId.unref()

  // 注册清理以在关闭时停止轮询
  registerCleanup(async () => stopBackgroundPolling())
}

/**
 * 停止远程设置的后台轮询
 */
export function stopBackgroundPolling(): void {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId)
    pollingIntervalId = null
  }
}
