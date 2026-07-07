import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import { execa } from 'execa'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getAPIProvider,
  isAnthropicProvider,
  isOpenAIProvider,
} from 'src/services/model/providers.js'
import { getSecureStorage } from 'src/services/secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from 'src/services/secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from 'src/services/secureStorage/macOsKeychainHelpers.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from '../../utils/authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from '../../utils/authPortable.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { logAntError, logForDebugging } from '../../utils/debug.js'
import { getZyConfigHomeDir, isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { execSyncWithDefaults_DEPRECATED } from '../../utils/execFileNoThrow.js'
import * as lockfile from '../../utils/lockfile.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../config/config.js'
import { getMockSubscriptionType, shouldUseMockSubscription } from '../mockRateLimits.js'
import type { OAuthTokens, SubscriptionType } from '../oauth/types.js'
import {
  clearAllOAuthCredentials,
  clearOAuthCredentialsCache,
  getActiveOAuthApiKeySync,
  getActiveOAuthProvider,
  getActiveOAuthProviderInfo,
  getOAuthCredentials,
  getOAuthCredentialsAsync,
  isActiveOAuthTokenExpired,
  refreshActiveOAuthToken,
  saveOAuthCredentials,
} from '../oauth/oauthStorage.js'
import { getOAuthProvider } from '../oauth/providers/index.js'

/** API key helper 缓存的默认 TTL，单位毫秒（5 分钟） */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * CCR 和 Zy Desktop 通过 OAuth 启动 CLI，不应回退到用户
 * ~/.zy/settings.json 中的 API key 配置（apiKeyHelper、
 * env.ZY_API_KEY、env.ANTHROPIC_AUTH_TOKEN）。这些配置是为用户
 * 终端 CLI 准备的，而非托管会话。如果没有这个保护，在终端中
 * 使用 API key 运行 `zy` 的用户会发现每个 CCD 会话也使用该
 * key——如果 key 过期或属于错误组织则会失败。
 */
function isManagedOAuthContext(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_REMOTE) || process.env.ZY_CODE_ENTRYPOINT === 'zy-desktop'
}

function getProviderScopedSettings(provider?: string) {
  const settings = getInitialSettings()
  const providerId = provider ?? settings.provider ?? getAPIProvider()
  return settings.providers?.[providerId]
}

/** 是否支持直连 API 认证。 */
// 此代码与 getAuthTokenSource 密切相关
export function isZyAISubscriber(): boolean {
  // 跳过登录检查，始终返回 false 以避免 OAuth 检查
  return false
}

/**
 * 检查认证是否启用
 */
export function isAuthEnabled(): boolean {
  // 检查 settings.json (zy.json) 中配置的 API key
  const settings = getInitialSettings()
  if (getProviderScopedSettings(settings.provider)?.apiKey || settings?.apiKey) {
    return true
  }

  // 检查 onboarding 时配置的 API key 和其他来源
  const config = getGlobalConfig()
  if (config.configuredApiKey) {
    return true
  }

  const { hasToken } = getAuthTokenSource()
  if (hasToken) {
    return true
  }

  // 检查多 Provider OAuth 登录
  if (getActiveOAuthProvider()) {
    return true
  }

  return false
}

/** 认证 token 的来源（如有）。 */
// 此代码与 isAuthEnabled 密切相关
export function getAuthTokenSource() {
  // 检查 settings.json (zy.json) 中配置的 API key
  const settings = getInitialSettings()
  if (getProviderScopedSettings(settings.provider)?.apiKey || settings?.apiKey) {
    return { source: 'settingsApiKey' as const, hasToken: true }
  }

  // 检查 onboarding 时配置的 API key
  const config = getGlobalConfig()
  if (config.configuredApiKey) {
    return { source: 'configuredApiKey' as const, hasToken: true }
  }

  // --bare：仅 API key 模式。apiKeyHelper（来自 --settings）是唯一
  // 允许的 bearer token 格式来源。OAuth 环境变量、FD token 和
  // keychain 均被忽略。
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return { source: 'apiKeyHelper' as const, hasToken: true }
    }
    return { source: 'none' as const, hasToken: false }
  }

  // 检查文件描述符中的 OAuth token（或其 CCR 磁盘回退）
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // getOAuthTokenFromFileDescriptor 有一个为无法继承管道 FD 的
    // CCR 子进程准备的磁盘回退。
    return {
      source: 'CCR_OAUTH_TOKEN_FILE' as const,
      hasToken: true,
    }
  }

  // 检查 apiKeyHelper 是否已配置但不执行它
  // 这可以防止在信任建立之前执行任意代码的安全问题
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper' as const, hasToken: true }
  }

  // 检查多 Provider OAuth
  const activeOAuthProvider = getActiveOAuthProvider()
  if (activeOAuthProvider) {
    return { source: 'oauth' as const, hasToken: true }
  }

  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'settingsApiKey'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'oauth'
  | 'none'

export function getApiKey(provider?: string): null | string {
  const { key } = getApiKeyWithSource({ provider })
  return key
}

export function hasApiKeyAuth(): boolean {
  const { key, source } = getApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null && source !== 'none'
}

export function getApiKeyWithSource(
  opts: { skipRetrievingKeyFromApiKeyHelper?: boolean; provider?: string } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  // 检查 settings.json (zy.json) 中配置的 API key
  const settings = getInitialSettings()
  const providerApiKey = getProviderScopedSettings(opts.provider)?.apiKey
  if (providerApiKey) {
    return { key: providerApiKey, source: 'settingsApiKey' }
  }
  if (settings?.apiKey) {
    return { key: settings.apiKey, source: 'settingsApiKey' }
  }

  // 检查 onboarding 时配置的 API key
  const config = getGlobalConfig()
  if (config.configuredApiKey) {
    return { key: config.configuredApiKey, source: 'settingsApiKey' }
  }

  // --bare：密封认证。仅使用来自 --settings 标志的 apiKeyHelper。
  // 第三方（Bedrock/Vertex/Foundry）使用 provider 凭据，不走此路径。
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper ? null : getApiKeyFromApiKeyHelperCached(),
        source: 'apiKeyHelper',
      }
    }
    return { key: null, source: 'none' }
  }

  // 检查文件描述符中的 API key
  const apiKeyFromFd = getApiKeyFromFileDescriptor()
  if (apiKeyFromFd) {
    return {
      key: apiKeyFromFd,
      source: 'settingsApiKey',
    }
  }

  // 检查 apiKeyHelper —— 使用同步缓存，不阻塞
  const apiKeyHelperCommand = getConfiguredApiKeyHelper()
  if (apiKeyHelperCommand) {
    if (opts.skipRetrievingKeyFromApiKeyHelper) {
      return {
        key: null,
        source: 'apiKeyHelper',
      }
    }
    // 缓存可能还未预热（helper 尚未完成）。返回 null 并设置
    // source='apiKeyHelper'，而非回退到 keychain——
    // apiKeyHelper 必须优先。需要真实 key 的调用方必须先 await
    // getApiKeyFromApiKeyHelper()（client.ts、useApiKeyVerification 已这样做）。
    return {
      key: getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }

  // 检查多 Provider OAuth（新增）
  const oauthApiKey = getActiveOAuthApiKeySync()
  if (oauthApiKey) {
    return { key: oauthApiKey, source: 'oauth' as const }
  }

  const apiKeyFromConfigOrMacOSKeychain = getApiKeyFromConfigOrMacOSKeychain()
  if (apiKeyFromConfigOrMacOSKeychain) {
    return apiKeyFromConfigOrMacOSKeychain
  }

  return {
    key: null,
    source: 'none',
  }
}

/**
 * 从 settings 中获取已配置的 apiKeyHelper。
 * 在 bare 模式下，仅查询 --settings 标志来源——
 * ~/.zy/settings.json 或项目设置中的 apiKeyHelper 会被忽略。
 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getInitialSettings() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * 检查已配置的 apiKeyHelper 是否来自项目设置（projectSettings 或 localSettings）
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper || localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/**
 * 计算 API key helper 缓存的 TTL（毫秒）
 * 如果设置了有效的 ZY_CODE_API_KEY_HELPER_TTL_MS 环境变量则使用该值，
 * 否则默认为 5 分钟
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.ZY_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found ZY_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// 异步 API key helper，带同步缓存以支持非阻塞读取。
// clearApiKeyHelperCache() 时 epoch 递增——孤立的执行会在修改模块状态前
// 检查其捕获的 epoch，从而避免正在进行中的设置变更或 401 重试覆盖新缓存。
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // 仅在冷启动时设置（用户正在等待）；SWR 后台刷新时为 null。
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) {
    return null
  }
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // 已过期——先返回过期值，在后台刷新。
    // `??=` 在此处被 eslint no-nullish-assign-object-call 禁止（bun bug）。
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(isNonInteractiveSession, false, _apiKeyHelperEpoch),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // 冷缓存——去重并发调用
  if (_apiKeyHelperInflight) {
    return _apiKeyHelperInflight.promise
  }
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    if (epoch !== _apiKeyHelperEpoch) {
      return value
    }
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) {
      return ' '
    }
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR 路径：临时失败不应该用 ' ' 哨兵值替换有效的 key——
    // 继续提供过期值并更新时间戳，避免每次调用都重试。
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // 冷缓存或之前已出错——缓存 ' ' 使调用方不会回退到 OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

async function _executeApiKeyHelper(isNonInteractiveSession: boolean): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('zy_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa 在 exit!=0 或超时时 resolve，stderr 在 result 上
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * 同步缓存读取器——返回上次获取的 apiKeyHelper 值，不执行命令。
 * 返回过期值以匹配异步读取器的 SWR 语义。
 * 仅在异步获取尚未完成时返回 null。
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(isNonInteractiveSession: boolean): void {
  // 如果信任尚未被接受则跳过——内部的 _executeApiKeyHelper 检查
  // 也会捕获这种情况，但会触发误报的分析事件。
  if (isApiKeyHelperFromProjectOrLocalSettings() && !checkHasTrustDialogAccepted()) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/**
 * 从 settings 中获取已配置的 gcpAuthRefresh
 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getInitialSettings() || {}
  return mergedSettings.gcpAuthRefresh
}

/**
 * 检查已配置的 gcpAuthRefresh 是否来自项目设置
 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** @private 请使用 {@link getApiKey} 或 {@link getApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) {
      return null
    }
    // TODO: 迁移到 SecureStorage
    if (process.platform === 'darwin') {
      // keychainPrefetch.ts 在 main.tsx 顶层与模块导入并行触发此读取。
      // 如果已完成，使用该结果而非在此处生成同步 `security` 子进程（约 33ms）。
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          return { key: prefetch.stdout, source: '/login managed key' }
        }
        // 预取完成但没有 key——回退到 config，而非 keychain。
      } else {
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          const result = execSyncWithDefaults_DEPRECATED(
            `security find-generic-password -a $USER -w -s "${storageServiceName}"`,
          )
          if (result) {
            return { key: result, source: '/login managed key' }
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    const config = getGlobalConfig()
    if (!config.primaryApiKey) {
      return null
    }

    return { key: config.primaryApiKey, source: '/login managed key' }
  },
)

function isValidApiKey(apiKey: string): boolean {
  // 仅允许字母数字、短横线和下划线
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // 作为主 API key 存储
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: 迁移到 SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // 转换为十六进制以避免任何转义问题
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // 使用 security 的交互模式 (-i) 配合 -X（十六进制）选项
      // 确保凭据不会出现在进程命令行参数中
      // 进程监控器只能看到 "security -i"，看不到密码
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('zy_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('zy_api_key_keychain_error', {
        error: errorMessage(e) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('zy_api_key_saved_to_config', {})
    }
  } else {
    logEvent('zy_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // 保存配置（包含所有更新）
  saveGlobalConfig((current) => {
    const approved = current.apiKeyResponses?.approved ?? []
    return {
      ...current,
      // 仅在 keychain 保存失败或不在 darwin 平台时保存到配置
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      apiKeyResponses: {
        ...current.apiKeyResponses,
        approved: approved.includes(normalizedKey) ? approved : [...approved, normalizedKey],
        rejected: current.apiKeyResponses?.rejected ?? [],
      },
    }
  })

  // 清除 memo 缓存
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return config.apiKeyResponses?.approved?.includes(normalizedKey) ?? false
}

export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // 同时从配置中移除而非提前返回，以兼容在支持 keychain 之前设置 key 的旧客户端。
  saveGlobalConfig((current) => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // 清除 memo 缓存
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

/**
 * 获取当前 OAuth access token（兼容层）。
 * 从新的多 Provider OAuth 存储中读取活跃 provider 的 access token。
 * 外部模块通过 utils/auth.ts 导入此函数获取当前 token。
 */
export const getZyAIOAuthTokens = memoize((): OAuthTokens | null => {
  if (isBareMode()) {
    return null
  }

  // 检查文件描述符中的 OAuth token
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // 从新的多 Provider OAuth 存储读取
  const apiKey = getActiveOAuthApiKeySync()
  if (!apiKey) {
    return null
  }

  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return null
  }

  const credentials = getOAuthCredentials(providerId)
  if (!credentials) {
    return null
  }

  return {
    accessToken: credentials.access,
    refreshToken: credentials.refresh,
    expiresAt: credentials.expires || null,
    scopes: [],
    subscriptionType: null,
    rateLimitTier: null,
  }
})

/**
 * 检查 OAuth token 是否已过期（含 5 分钟安全余量）。
 */
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (!expiresAt) {
    return false
  }
  return Date.now() >= expiresAt - 5 * 60 * 1000
}

/**
 * 清除所有 OAuth token 缓存。在 401 错误时调用此方法以确保
 * 下次 token 读取来自安全存储，而非过期的内存缓存。
 * 此方法处理本地过期检查与服务器不一致的情况
 * （例如，token 签发后发生了时钟校正）。
 */
export function clearOAuthTokenCache(): void {
  getZyAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
  clearOAuthCredentialsCache()
}

// 飞行中去重：当 N 个 zy.ai 代理连接器同时以相同 token 触发 401 时
// （启动时常见——#20930），应只有一个清除缓存并重新读取 keychain。
// 如果没有这个机制，每次调用的 clearOAuthTokenCache() 都会销毁
// macOsKeychainStorage 中的 readInFlight 并触发新的 spawn——
// 同步 spawn 堆叠导致 800ms+ 的渲染帧阻塞。
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * 处理来自 API 的 401 "OAuth token has expired" 错误。
 *
 * 当服务器表示 token 已过期时，此函数强制刷新 token，
 * 即使本地过期检查不同意（这可能因 token 签发时的时钟问题导致）。
 *
 * 安全性：我们将失败的 token 与 keychain 中的 token 对比。如果另一个标签页
 * 已刷新（keychain 中是不同的 token），则直接使用该 token 而非再次刷新。
 * 使用相同 failedAccessToken 的并发调用会被去重为单次 keychain 读取。
 *
 * @param failedAccessToken - 被 401 拒绝的 access token
 * @returns 如果现在有有效 token 则返回 true，否则返回 false
 */
export function handleOAuth401Error(failedAccessToken: string): Promise<boolean> {
  const pending = pending401Handlers.get(failedAccessToken)
  if (pending) {
    return pending
  }

  const promise = handleOAuth401ErrorImpl(failedAccessToken).finally(() => {
    pending401Handlers.delete(failedAccessToken)
  })
  pending401Handlers.set(failedAccessToken, promise)
  return promise
}

async function handleOAuth401ErrorImpl(failedAccessToken: string): Promise<boolean> {
  // 首先检查是否是多 Provider OAuth
  const activeProvider = getActiveOAuthProvider()
  if (activeProvider) {
    // 多 Provider OAuth 401 处理：强制刷新 token
    clearOAuthCredentialsCache()
    const credentials = getOAuthCredentials(activeProvider)
    if (!credentials) {
      return false
    }
    // 检查 keychain 中是否有不同的 token（另一个进程可能已刷新）
    if (credentials.access !== failedAccessToken) {
      logEvent('zy_oauth_401_recovered_from_keychain', {})
      return true
    }
    // 相同 token 失败——强制刷新
    return checkAndRefreshOAuthTokenIfNeeded(0, true)
  }

  // 无活跃 OAuth provider，无法处理 401
  return false
}

// 用于去重并发调用的飞行中 Promise
const _pendingRefreshCheck: Promise<boolean> | null = null

export function checkAndRefreshOAuthTokenIfNeeded(
  _retryCount = 0,
  force = false,
): Promise<boolean> {
  // 统一使用多 Provider OAuth 刷新
  return _checkAndRefreshMultiProviderOAuthTokenImpl(force)
}

/**
 * 多 Provider OAuth token 刷新实现。
 * 检查活跃 provider 的 token 是否过期，过期则刷新。
 */
async function _checkAndRefreshMultiProviderOAuthTokenImpl(force: boolean): Promise<boolean> {
  try {
    if (!force) {
      // 检查 token 是否已过期
      if (!isActiveOAuthTokenExpired()) {
        return false
      }
    }
    // 强制刷新或 token 已过期，执行刷新
    const refreshed = await refreshActiveOAuthToken()
    if (refreshed) {
      clearOAuthCredentialsCache()
    }
    return refreshed
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * 检查当前 OAuth token 是否具有 user:profile scope。
 *
 * 真正的 /login token 始终包含此 scope。环境变量和文件描述符
 * token（service key）将 scopes 硬编码为仅 ['user:inference']。使用此方法
 * 来控制对 profile scope 端点的调用，防止 service key 会话
 * 对 /api/oauth/profile、bootstrap 等产生 403 风暴。
 */
export function hasProfileScope(): boolean {
  // 多 Provider OAuth 模式下不使用 profile scope
  return false
}

export function isDirectApiClient(): boolean {
  // 直连 API 客户是不属于以下类别的用户：
  // 1. ZY 订阅用户（Max、Pro、Enterprise、Team）
  // 2. 云服务商用户

  // 排除 Zy.ai 订阅用户
  if (isZyAISubscriber()) {
    return false
  }

  // 其他所有人都是 API 客户（OAuth API 客户、直连 API key 用户等）
  return true
}

/**
 * 在认证启用时获取 OAuth 账户信息。
 * 使用外部 API key 或第三方服务时返回 undefined。
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return isAuthEnabled() ? getGlobalConfig().oauthAccount : undefined
}

/**
 * 检查此组织是否允许超额/额外用量配置。
 * 尽可能贴近 apps/zy-ai 中 `useIsOverageProvisioningAllowed` hook 的逻辑。
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // 必须是具有受支持订阅类型的 Zy 订阅用户
  if (!isZyAISubscriber() || !billingType) {
    return false
  }

  // 仅允许 Stripe 和移动端计费类型购买额外用量
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// 返回用户是否拥有 Opus 访问权限，无论其是订阅用户还是按量付费用户。
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    (subscriptionType as string) === 'max' ||
    (subscriptionType as string) === 'enterprise' ||
    (subscriptionType as string) === 'team' ||
    (subscriptionType as string) === 'pro' ||
    // subscriptionType === null 涵盖了 API 用户以及订阅用户尚未填充
    // 订阅类型的情况。对于这些订阅用户，在不确定时不应限制其 Opus 访问权限。
    subscriptionType === null
  )
}

export function getSubscriptionType(): SubscriptionType | null {
  // 首先检查模拟订阅类型（仅内部测试）
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }
  // 多 Provider OAuth 模式下不支持订阅类型
  return null
}

export function getRateLimitTier(): string | null {
  // 多 Provider OAuth 模式下不支持速率限制层级
  return null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType as string) {
    case 'enterprise':
      return 'ZY Enterprise'
    case 'team':
      return 'ZY Team'
    case 'max':
      return 'ZY Max'
    case 'pro':
      return 'ZY Pro'
    default:
      return 'ZY API'
  }
}

/**
 * 从 settings 中获取已配置的 otelHeadersHelper
 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getInitialSettings() || {}
  return mergedSettings.otelHeadersHelper
}

/**
 * 检查已配置的 otelHeadersHelper 是否来自项目设置（projectSettings 或 localSettings）
 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// otelHeadersHelper 调用的防抖缓存
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 分钟

export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // 如果缓存仍有效则返回缓存的 headers（防抖）
  const debounceMs = parseInt(
    process.env.ZY_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
    10,
  )
  if (cachedOtelHeaders && Date.now() - cachedOtelHeadersTimestamp < debounceMs) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // 检查此项目是否已建立信任
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 秒——允许认证服务延迟
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error('otelHeadersHelper must return a JSON object with string key-value pairs')
    }

    // 验证所有值都是字符串
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // 缓存结果
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

// @ts-expect-error
function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return (plan as string) === 'max' || (plan as string) === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return isZyAISubscriber() && subscriptionType !== null && isConsumerPlan(subscriptionType)
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // 仅为 Anthropic 直连或使用 OpenAI SDK 的 provider 提供账户信息（Google 等平台使用自身认证）
  if (!isAnthropicProvider(apiProvider) && !isOpenAIProvider(apiProvider)) {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource()
  const accountInfo: UserAccountInfo = {}
  accountInfo.tokenSource = authTokenSource

  const { key: apiKey, source: apiKeySource } = getApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }

  // 从 OAuth 账户信息获取组织名称和邮箱
  const oauthAccount = getOauthAccountInfo()
  if (oauthAccount?.organizationName) {
    accountInfo.organization = oauthAccount.organizationName
  }
  if (oauthAccount?.emailAddress) {
    accountInfo.email = oauthAccount.emailAddress
  }
  return accountInfo
}

/**
 * 组织验证结果——成功或描述性错误。
 */
export type OrgValidationResult = { valid: true } | { valid: false; message: string }

/**
 * 验证当前 OAuth token 是否属于托管设置中 `forceLoginOrgUUID` 所要求的组织。
 *
 * 多 Provider OAuth 模式下无法通过 zy.ai profile 端点验证组织，
 * 仅在有缓存的组织 UUID 时进行比对。
 */
export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return { valid: true }
  }

  if (!isAuthEnabled()) {
    return { valid: true }
  }

  const requiredOrgUuid = getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { valid: true }
  }

  // 从缓存的账户信息中获取组织 UUID
  const orgUuid = getGlobalConfig().oauthAccount?.organizationUuid
  if (!orgUuid) {
    // 无法验证——安全关闭
    return { valid: true }
  }

  if (orgUuid === requiredOrgUuid) {
    return { valid: true }
  }

  return {
    valid: false,
    message:
      `Your authentication token belongs to organization ${orgUuid},\n` +
      `but this machine requires organization ${requiredOrgUuid}.\n\n` +
      `Please log in with the correct organization: zy auth login`,
  }
}

class GcpCredentialsTimeoutError extends Error {}

/**
 * 获取当前用户的组织 UUID。
 * 从全局配置中读取缓存的组织信息，多 Provider OAuth 模式下不再调用 zy.ai profile API。
 */
export async function getOrganizationUUID(): Promise<string | null> {
  const orgUUID = getGlobalConfig().oauthAccount?.organizationUuid
  return orgUUID ?? null
}

/**
 * 填充 OAuth 账户信息（如果尚未缓存）。
 * 多 Provider OAuth 模式下此函数为空操作，账户信息在登录时由 provider 直接保存。
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  return false
}

// 重新导出多 Provider OAuth 工具函数，供外部模块使用
export {
  getActiveOAuthProviderInfo,
  getActiveOAuthProvider,
  saveOAuthCredentials,
  clearAllOAuthCredentials,
} from '../oauth/oauthStorage.js'
