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
import { getSecureStorage } from 'src/services/secure-storage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from 'src/services/secure-storage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
} from 'src/services/secure-storage/macOsKeychainHelpers.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from '../auth/authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from '../auth/authPortable.js'
import { clearBetasCaches } from '../feature-flags/betas.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { getZyConfigHomeDir, isBareMode, isEnvTruthy } from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { execSyncWithDefaults_DEPRECATED } from '../shell/execFileNoThrow.js'
import * as lockfile from '../file-persistence/lockfile.js'
import { logError } from '../../services/infra/log.js'
import { getInitialSettings, getSettingsForSource } from '../settings/settings.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse } from '../../services/infra/slowOperations.js'
import { clearToolSchemaCache } from '../../services/api/toolSchemaCache.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../config/config.js'
import { getMockSubscriptionType, shouldUseMockSubscription } from '../mockRateLimits.js'
import { getMainLoopModel, getProviderForModel } from '../model/model.js'
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
import type { OAuthTokens, SubscriptionType } from '../oauth/types.js'
import {
  clearAllAuthConfigApiKeys,
  getAuthConfigApiKey,
  getAuthConfigApiKeyHelper,
  setAuthConfigApiKey,
} from './authConfig.js'

/** API key helper 缓存的默认 TTL，单位毫秒（5 分钟） */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * CCR 和 Zy Desktop 通过 OAuth 启动 CLI，不应回退到用户
 * 终端 CLI 的 API key 配置（auth.json、apiKeyHelper、env.ZY_API_KEY、
 * env.ANTHROPIC_AUTH_TOKEN）。如果没有这个保护，在终端中使用 API key
 * 运行 `zy` 的用户会发现每个 CCD 会话也使用该 key——如果 key 过期
 * 或属于错误组织则会失败。
 */
function isManagedOAuthContext(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_REMOTE) || process.env.ZY_CODE_ENTRYPOINT === 'zy-desktop'
}

function getAuthProviderId(provider?: string): string | undefined {
  if (provider) {
    return provider
  }
  const model = getMainLoopModel()
  if (model) {
    return getProviderForModel(model)
  }
  return getInitialSettings().provider ?? getAPIProvider()
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
  // 检查用户级 auth.json 中配置的 API key / apiKeyHelper。
  const settings = getInitialSettings()
  const provider = getAuthProviderId(settings.provider)
  if (getAuthConfigApiKey(provider) || getAuthConfigApiKeyHelper(provider)) {
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
  // 检查用户级 auth.json 中配置的 API key。
  const settings = getInitialSettings()
  const provider = getAuthProviderId(settings.provider)
  if (getAuthConfigApiKey(provider)) {
    return { source: 'settingsApiKey' as const, hasToken: true }
  }

  // --bare：仅 API key 模式。auth.json 中的 apiKeyHelper 是唯一允许的
  // bearer token 格式来源。OAuth 环境变量、FD token 和 keychain 均被忽略。
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper(provider)) {
      return { source: 'apiKeyHelper' as const, hasToken: true }
    }
    return { source: 'none' as const, hasToken: false }
  }

  // 多 Provider OAuth（有 active 即视为有 token）
  if (getActiveOAuthProvider()) {
    return { source: 'oauth' as const, hasToken: true }
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

  // 只检查 apiKeyHelper 是否已配置，不在 token 来源探测阶段执行命令。
  const apiKeyHelper = getConfiguredApiKeyHelper(provider)
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper' as const, hasToken: true }
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
  // 检查用户级 auth.json 中配置的 API key。
  const provider = getAuthProviderId(opts.provider)
  const authConfigApiKey = getAuthConfigApiKey(provider)
  if (authConfigApiKey) {
    return { key: authConfigApiKey, source: 'settingsApiKey' }
  }

  // --bare：密封认证。仅使用来自用户级 auth.json 的 apiKeyHelper。
  // 第三方（Bedrock/Vertex/Foundry）使用 provider 凭据，不走此路径。
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper(provider)) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper
          ? null
          : getApiKeyFromApiKeyHelperCached(provider),
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
  const apiKeyHelperCommand = getConfiguredApiKeyHelper(provider)
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
      key: getApiKeyFromApiKeyHelperCached(provider),
      source: 'apiKeyHelper',
    }
  }

  // 多 Provider OAuth：仅当 OAuth 绑定的 apiProvider 与当前请求 provider 一致时使用。
  const activeOAuthInfo = getActiveOAuthProviderInfo()
  if (activeOAuthInfo) {
    const oauthApiProvider = activeOAuthInfo.apiProvider
    const providerMatches = !oauthApiProvider || !provider || oauthApiProvider === provider
    if (providerMatches) {
      const oauthApiKey = getActiveOAuthApiKeySync()
      if (oauthApiKey) {
        return { key: oauthApiKey, source: 'oauth' as const }
      }
    }
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
 * 从用户级 auth.json 中获取已配置的 apiKeyHelper。
 */
export function getConfiguredApiKeyHelper(provider?: string): string | undefined {
  const providerId = getAuthProviderId(provider)
  return getAuthConfigApiKeyHelper(providerId)
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
type ApiKeyHelperInflight = {
  promise: Promise<string | null>
  // 仅在冷启动时设置（用户正在等待）；SWR 后台刷新时为 null。
  startedAt: number | null
}

const _apiKeyHelperCache = new Map<string, { value: string; timestamp: number }>()
const _apiKeyHelperInflight = new Map<string, ApiKeyHelperInflight>()
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  let elapsed = 0
  for (const inflight of _apiKeyHelperInflight.values()) {
    if (inflight.startedAt) {
      elapsed = Math.max(elapsed, Date.now() - inflight.startedAt)
    }
  }
  return elapsed
}

export async function getApiKeyFromApiKeyHelper(
  _isNonInteractiveSession: boolean,
  provider?: string,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper(provider)
  if (!apiKeyHelper) {
    return null
  }
  const ttl = calculateApiKeyHelperTTL()
  const cached = _apiKeyHelperCache.get(apiKeyHelper)
  if (cached) {
    if (Date.now() - cached.timestamp < ttl) {
      return cached.value
    }
    // 已过期——先返回过期值，在后台刷新。
    // `??=` 在此处被 eslint no-nullish-assign-object-call 禁止（bun bug）。
    if (!_apiKeyHelperInflight.has(apiKeyHelper)) {
      _apiKeyHelperInflight.set(apiKeyHelper, {
        promise: _runAndCache(apiKeyHelper, false, _apiKeyHelperEpoch),
        startedAt: null,
      })
    }
    return cached.value
  }
  // 冷缓存——去重并发调用
  const inflight = _apiKeyHelperInflight.get(apiKeyHelper)
  if (inflight) {
    return inflight.promise
  }
  _apiKeyHelperInflight.set(apiKeyHelper, {
    promise: _runAndCache(apiKeyHelper, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  })
  return _apiKeyHelperInflight.get(apiKeyHelper)?.promise ?? null
}

async function _runAndCache(
  apiKeyHelper: string,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(apiKeyHelper)
    if (epoch !== _apiKeyHelperEpoch) {
      return value
    }
    if (value !== null) {
      _apiKeyHelperCache.set(apiKeyHelper, { value, timestamp: Date.now() })
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
    const cached = _apiKeyHelperCache.get(apiKeyHelper)
    if (!isCold && cached && cached.value !== ' ') {
      _apiKeyHelperCache.set(apiKeyHelper, { ...cached, timestamp: Date.now() })
      return cached.value
    }
    // 冷缓存或之前已出错——缓存 ' ' 使调用方不会回退到 OAuth
    _apiKeyHelperCache.set(apiKeyHelper, { value: ' ', timestamp: Date.now() })
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight.delete(apiKeyHelper)
    }
  }
}

async function _executeApiKeyHelper(apiKeyHelper: string): Promise<string | null> {
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
export function getApiKeyFromApiKeyHelperCached(provider?: string): string | null {
  const apiKeyHelper = getConfiguredApiKeyHelper(provider)
  if (!apiKeyHelper) {
    return null
  }
  return _apiKeyHelperCache.get(apiKeyHelper)?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache.clear()
  _apiKeyHelperInflight.clear()
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(isNonInteractiveSession: boolean): void {
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

/**
 * 一次性迁移：旧 keychain / ~/.zy.json primaryApiKey → auth.json。
 * 读到后写入当前 provider 的 auth 条目并清掉 legacy 存储；之后运行时只认 auth.json。
 * @private 请使用 {@link getApiKey} 或 {@link getApiKeyWithSource}
 */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) {
      return null
    }

    let legacyKey: string | null = null

    if (process.platform === 'darwin') {
      // keychainPrefetch 与 main 导入并行；完成后走预取结果，避免同步 security ~33ms
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          legacyKey = prefetch.stdout
        }
      } else {
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          const result = execSyncWithDefaults_DEPRECATED(
            `security find-generic-password -a $USER -w -s "${storageServiceName}"`,
          )
          if (result) {
            legacyKey = result
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    if (!legacyKey) {
      const config = getGlobalConfig()
      if (config.primaryApiKey) {
        legacyKey = config.primaryApiKey
      }
    }

    if (!legacyKey) {
      return null
    }

    // 迁入 auth.json（当前 provider）；已有 auth 条目时不覆盖
    const provider = getAuthProviderId()
    if (provider && !getAuthConfigApiKey(provider)) {
      const written = setAuthConfigApiKey(provider, legacyKey)
      if (written.success) {
        logEvent('zy_api_key_migrated_to_auth_json', {})
      } else {
        logForDebugging(
          `legacy api key migrate to auth.json failed: ${written.warning ?? 'unknown'}`,
          { level: 'warn' },
        )
      }
    }

    // 无论是否写成功，清掉 legacy，避免永久双轨
    void maybeRemoveApiKeyFromMacOSKeychain()
    saveGlobalConfig((current) => {
      if (current.primaryApiKey === undefined) {
        return current
      }
      return { ...current, primaryApiKey: undefined }
    })
    clearLegacyApiKeyPrefetch()

    return { key: legacyKey, source: '/login managed key' }
  },
)

function isValidApiKey(apiKey: string): boolean {
  // 仅允许字母数字、短横线和下划线
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

/**
 * 将 API key 写入 auth.json（当前 provider），并记录 approved 指纹。
 * 不再写入 macOS keychain 或 ~/.zy.json primaryApiKey。
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  const provider = getAuthProviderId()
  if (!provider) {
    throw new Error('Cannot save API key: no provider configured')
  }

  const written = setAuthConfigApiKey(provider, apiKey)
  if (!written.success) {
    throw new Error(written.warning ?? 'Failed to write auth.json')
  }

  // 清理历史 legacy 存储，保证单源
  await maybeRemoveApiKeyFromMacOSKeychain()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  saveGlobalConfig((current) => {
    const approved = current.apiKeyResponses?.approved ?? []
    return {
      ...current,
      primaryApiKey: undefined,
      apiKeyResponses: {
        ...current.apiKeyResponses,
        approved: approved.includes(normalizedKey) ? approved : [...approved, normalizedKey],
        rejected: current.apiKeyResponses?.rejected ?? [],
      },
    }
  })

  logEvent('zy_api_key_saved_to_auth_json', {})
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return config.apiKeyResponses?.approved?.includes(normalizedKey) ?? false
}

/**
 * 清除 auth.json 中全部 apiKey，并清掉 keychain / primaryApiKey legacy。
 */
export async function removeApiKey(): Promise<void> {
  clearAllAuthConfigApiKeys()
  await maybeRemoveApiKeyFromMacOSKeychain()
  saveGlobalConfig((current) => ({
    ...current,
    primaryApiKey: undefined,
  }))

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
  clearAllOAuthCredentials,
  getActiveOAuthProvider,
  getActiveOAuthProviderInfo,
  saveOAuthCredentials,
} from '../oauth/oauthStorage.js'
