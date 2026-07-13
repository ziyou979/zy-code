/**
 * 多 Provider OAuth 凭证存储层
 *
 * 使用现有 SecureStorage（keychain）存储多个 OAuth provider 的凭证。
 * 存储结构：
 * {
 *   "oauth": {
 *     "anthropic": { refresh, access, expires },
 *     "openai-codex": { refresh, access, expires, accountId }
 *   },
 *   "activeOAuthProvider": "anthropic"
 * }
 */

import memoize from 'lodash-es/memoize.js'
import { logError } from '../../utils/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getSecureStorage } from '../secure-storage/index.js'
import { clearKeychainCache } from '../secure-storage/macOsKeychainHelpers.js'
import { getOAuthApiKey, getOAuthProvider } from './providers/index.js'
import type { OAuthCredentials, OAuthProviderInterface } from './providers/types.js'

// biome-ignore lint/suspicious/noExplicitAny: SecureStorage 运行时有扩展方法
type SecureStorageWithMethods = any

/** 获取 SecureStorage 实例（带类型断言以访问 read/update 方法） */
function getStorage(): SecureStorageWithMethods {
  return getSecureStorage() as SecureStorageWithMethods
}

/** 同步读取 OAuth 凭证（带 memoize 缓存） */
export const getOAuthCredentials = memoize((providerId: string): OAuthCredentials | null => {
  try {
    const storage = getStorage()
    const storageData = storage.read()
    const oauthData = storageData?.oauth?.[providerId]
    if (!oauthData?.access) {
      return null
    }
    return oauthData as OAuthCredentials
  } catch (error) {
    logError(error)
    return null
  }
})

/** 异步读取 OAuth 凭证 */
export async function getOAuthCredentialsAsync(
  providerId: string,
): Promise<OAuthCredentials | null> {
  try {
    const storage = getStorage()
    const storageData = await storage.readAsync()
    const oauthData = storageData?.oauth?.[providerId]
    if (!oauthData?.access) {
      return null
    }
    return oauthData as OAuthCredentials
  } catch (error) {
    logError(error)
    return null
  }
}

/** 获取活跃 OAuth Provider ID */
export function getActiveOAuthProvider(): string | null {
  try {
    const storage = getStorage()
    const storageData = storage.read()
    return storageData?.activeOAuthProvider ?? null
  } catch (error) {
    logError(error)
    return null
  }
}

/** 设置活跃 OAuth Provider */
export function setActiveOAuthProvider(providerId: string): void {
  try {
    const storage = getStorage()
    const storageData = storage.read() || {}
    storageData.activeOAuthProvider = providerId
    storage.update(storageData)
    clearOAuthCredentialsCache()
  } catch (error) {
    logError(error)
  }
}

/** 保存 OAuth 凭证并设为活跃 provider */
export function saveOAuthCredentials(
  providerId: string,
  credentials: OAuthCredentials,
): { success: boolean; warning?: string } {
  try {
    const storage = getStorage()
    const storageData = storage.read() || {}

    if (!storageData.oauth) {
      storageData.oauth = {}
    }
    storageData.oauth[providerId] = credentials
    storageData.activeOAuthProvider = providerId

    const result = storage.update(storageData)
    clearOAuthCredentialsCache()

    if (result.success) {
      logEvent('zy_oauth_credentials_saved', {
        providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    } else {
      logEvent('zy_oauth_credentials_save_failed', {
        providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    return result
  } catch (error) {
    logError(error)
    logEvent('zy_oauth_credentials_save_exception', {
      providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: false, warning: 'Failed to save OAuth credentials' }
  }
}

/** 删除指定 provider 的 OAuth 凭证 */
export function removeOAuthCredentials(providerId: string): void {
  try {
    const storage = getStorage()
    const storageData = storage.read() || {}

    if (storageData.oauth) {
      delete storageData.oauth[providerId]
    }

    // 如果删除的是活跃 provider，清除活跃标记
    if (storageData.activeOAuthProvider === providerId) {
      // 如果还有其他 provider，选择第一个作为活跃
      const remainingProviders = Object.keys(storageData.oauth || {})
      storageData.activeOAuthProvider = remainingProviders.length > 0 ? remainingProviders[0] : null
    }

    storage.update(storageData)
    clearOAuthCredentialsCache()
  } catch (error) {
    logError(error)
  }
}

/** 清除所有 OAuth 凭证 */
export function clearAllOAuthCredentials(): void {
  try {
    const storage = getStorage()
    const storageData = storage.read() || {}

    delete storageData.oauth
    delete storageData.activeOAuthProvider

    storage.update(storageData)
    clearOAuthCredentialsCache()
  } catch (error) {
    logError(error)
  }
}

/** 清除凭证缓存 */
export function clearOAuthCredentialsCache(): void {
  getOAuthCredentials.cache?.clear?.()
  clearKeychainCache()
}

/**
 * 获取活跃 provider 的 API key（自动刷新过期 token）。
 *
 * 异步操作：读取 keychain → 检查过期 → 必要时刷新 → 返回 API key。
 */
export async function getActiveOAuthApiKey(): Promise<{
  key: string
  provider: string
} | null> {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return null
  }

  const credentials = await getOAuthCredentialsAsync(providerId)
  if (!credentials) {
    return null
  }

  try {
    const { newCredentials, apiKey } = await getOAuthApiKey(providerId, credentials)

    // 如果凭证被刷新了，保存新凭证
    if (newCredentials !== credentials) {
      saveOAuthCredentials(providerId, newCredentials)
    }

    return { key: apiKey, provider: providerId }
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * 同步获取活跃 provider 的 API key（从缓存读取，不过期检查）。
 *
 * 用于需要同步获取 API key 的场景（如 getApiKeyWithSource）。
 * 过期检查和刷新在后台异步进行。
 */
export function getActiveOAuthApiKeySync(): string | null {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return null
  }

  const credentials = getOAuthCredentials(providerId)
  if (!credentials) {
    return null
  }

  const provider = getOAuthProvider(providerId)
  if (!provider) {
    return null
  }

  return provider.getApiKey(credentials)
}

/**
 * 获取活跃 provider 的信息。
 *
 * 返回 provider 接口实例，可用于查询 apiProvider、apiFormat 等属性。
 */
export function getActiveOAuthProviderInfo(): OAuthProviderInterface | null {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return null
  }

  return getOAuthProvider(providerId) ?? null
}

/**
 * 检查活跃 provider 的凭证是否已过期。
 */
export function isActiveOAuthTokenExpired(): boolean {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return false
  }

  const credentials = getOAuthCredentials(providerId)
  if (!credentials) {
    return false
  }

  // 5 分钟缓冲
  const bufferTime = 5 * 60 * 1000
  return Date.now() + bufferTime >= credentials.expires
}

/**
 * 刷新活跃 provider 的 OAuth token。
 *
 * 用于 401 错误后的强制刷新。
 */
export async function refreshActiveOAuthToken(): Promise<boolean> {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return false
  }

  const provider = getOAuthProvider(providerId)
  if (!provider) {
    return false
  }

  const credentials = await getOAuthCredentialsAsync(providerId)
  if (!credentials) {
    return false
  }

  try {
    const newCredentials = await provider.refreshToken(credentials)
    saveOAuthCredentials(providerId, newCredentials)
    return true
  } catch (error) {
    logError(error)
    return false
  }
}
