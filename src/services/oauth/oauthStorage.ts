/**
 * 多 Provider OAuth 凭证存储层
 *
 * 仅存 `~/.zy/auth.json` 的 `oauth` 块（与 API Key 同文件）：
 * {
 *   "dashscope": { "apiKey": "..." },
 *   "oauth": {
 *     "activeProvider": "xai-oauth",
 *     "credentials": {
 *       "xai-oauth": { refresh, access, expires, ... }
 *     }
 *   }
 * }
 */

import memoize from 'lodash-es/memoize.js'
import {
  getAuthOAuthStore,
  saveAuthOAuthStore,
  type AuthOAuthCredentials,
  type AuthOAuthStore,
} from '../auth/authConfig.js'
import { logError } from '../../services/infra/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getOAuthApiKey, getOAuthProvider } from './providers/index.js'
import type { OAuthCredentials, OAuthProviderInterface } from './providers/types.js'

function loadOAuthStore(): AuthOAuthStore {
  return getAuthOAuthStore()
}

function persistOAuthStore(store: AuthOAuthStore): { success: boolean; warning?: string } {
  const result = saveAuthOAuthStore(store)
  clearOAuthCredentialsCache()
  return result
}

/** 同步读取 OAuth 凭证（带 memoize 缓存） */
export const getOAuthCredentials = memoize((providerId: string): OAuthCredentials | null => {
  try {
    const store = loadOAuthStore()
    const oauthData = store.credentials[providerId]
    if (!oauthData?.access) {
      return null
    }
    return oauthData as OAuthCredentials
  } catch (error) {
    logError(error)
    return null
  }
})

/** 异步读取 OAuth 凭证（与同步路径一致；保留 API 兼容） */
export async function getOAuthCredentialsAsync(
  providerId: string,
): Promise<OAuthCredentials | null> {
  return getOAuthCredentials(providerId)
}

/** 获取活跃 OAuth Provider ID */
export function getActiveOAuthProvider(): string | null {
  try {
    const store = loadOAuthStore()
    return store.activeProvider ?? null
  } catch (error) {
    logError(error)
    return null
  }
}

/** 设置活跃 OAuth Provider */
export function setActiveOAuthProvider(providerId: string): void {
  try {
    const store = loadOAuthStore()
    store.activeProvider = providerId
    persistOAuthStore(store)
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
    const store = loadOAuthStore()
    store.credentials[providerId] = credentials as AuthOAuthCredentials
    store.activeProvider = providerId

    const result = persistOAuthStore(store)

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
    const store = loadOAuthStore()
    delete store.credentials[providerId]

    if (store.activeProvider === providerId) {
      const remaining = Object.keys(store.credentials)
      store.activeProvider = remaining.length > 0 ? remaining[0] : null
    }

    persistOAuthStore(store)
  } catch (error) {
    logError(error)
  }
}

/** 清除所有 OAuth 凭证 */
export function clearAllOAuthCredentials(): void {
  try {
    persistOAuthStore({ activeProvider: null, credentials: {} })
  } catch (error) {
    logError(error)
  }
}

/** 清除凭证缓存 */
export function clearOAuthCredentialsCache(): void {
  getOAuthCredentials.cache?.clear?.()
}

/**
 * 获取活跃 provider 的 API key（自动刷新过期 token）。
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

  const bufferTime = 5 * 60 * 1000
  return Date.now() + bufferTime >= credentials.expires
}

/**
 * 刷新活跃 provider 的 OAuth token。
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
