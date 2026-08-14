/**
 * OAuth 凭证存储层。
 *
 * 正式结构与 API Key 一样按命名连接归属：
 * {
 *   "xai": {
 *     "oauth": { "provider": "xai-oauth", "access": "...", "refresh": "...", "expires": 0 }
 *   }
 * }
 *
 * 旧版根级 `oauth.activeProvider/credentials` 只读；下次写入时自动迁移。
 */

import memoize from 'lodash-es/memoize.js'
import {
  clearAllAuthConfigOAuth,
  getAuthConfigForProvider,
  getAuthOAuthConnections,
  getAuthOAuthStore,
  removeAuthConfigOAuth,
  setAuthConfigOAuth,
  type AuthOAuthCredentials,
} from '../auth/authConfig.js'
import { logError } from '../../services/infra/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from './providers/index.js'
import type { OAuthCredentials, OAuthProviderInterface } from './providers/types.js'

type StoredOAuthConnection = {
  connectionId: string
  providerId: string
  credentials: OAuthCredentials
}

function inferOAuthProviderId(connectionId: string): string | undefined {
  const apiProvider = getAuthConfigForProvider(connectionId)?.provider ?? connectionId
  return getOAuthProviders().find((provider) => provider.apiProvider === apiProvider)?.id
}

function getStoredOAuthConnections(): StoredOAuthConnection[] {
  const connections: StoredOAuthConnection[] = []
  const seen = new Set<string>()

  for (const connection of getAuthOAuthConnections()) {
    const providerId = connection.providerId ?? inferOAuthProviderId(connection.connectionId)
    if (!providerId) {
      continue
    }
    connections.push({
      connectionId: connection.connectionId,
      providerId,
      credentials: connection.credentials as OAuthCredentials,
    })
    seen.add(providerId)
  }

  // 兼容读取旧版全局存储，新连接数据优先。
  const legacyStore = getAuthOAuthStore()
  for (const [providerId, credentials] of Object.entries(legacyStore.credentials)) {
    if (seen.has(providerId)) {
      continue
    }
    const provider = getOAuthProvider(providerId)
    connections.push({
      connectionId: provider?.apiProvider ?? providerId,
      providerId,
      credentials: credentials as OAuthCredentials,
    })
  }
  return connections
}

function getConnectionByProviderId(providerId: string): StoredOAuthConnection | undefined {
  return getStoredOAuthConnections().find((connection) => connection.providerId === providerId)
}

function getConnectionById(connectionId: string): StoredOAuthConnection | undefined {
  const exact = getStoredOAuthConnections().find(
    (connection) => connection.connectionId === connectionId,
  )
  if (exact) {
    return exact
  }
  return getStoredOAuthConnections().find(
    (connection) => getOAuthProvider(connection.providerId)?.apiProvider === connectionId,
  )
}

function migrateLegacyCredentials(): void {
  const store = getAuthOAuthStore()
  for (const [providerId, credentials] of Object.entries(store.credentials)) {
    const provider = getOAuthProvider(providerId)
    setAuthConfigOAuth(
      provider?.apiProvider ?? providerId,
      providerId,
      credentials as AuthOAuthCredentials,
    )
  }
}

/** 同步按 OAuth 实现 ID 读取凭证（带 memoize 缓存）。 */
export const getOAuthCredentials = memoize((providerId: string): OAuthCredentials | null => {
  try {
    const credentials = getConnectionByProviderId(providerId)?.credentials
    return credentials?.access ? credentials : null
  } catch (error) {
    logError(error)
    return null
  }
})

export async function getOAuthCredentialsAsync(
  providerId: string,
): Promise<OAuthCredentials | null> {
  return getOAuthCredentials(providerId)
}

/** 按 settings 引用的命名连接读取 OAuth 凭证。 */
export function getOAuthCredentialsForConnection(connectionId?: string): OAuthCredentials | null {
  if (!connectionId) {
    return null
  }
  return getConnectionById(connectionId)?.credentials ?? null
}

export function getOAuthProviderIdForConnection(connectionId?: string): string | null {
  if (!connectionId) {
    return null
  }
  return getConnectionById(connectionId)?.providerId ?? null
}

/**
 * 返回兼容意义上的默认 OAuth provider。
 * 模型请求不依赖该值，而是按命名连接精确选取凭证。
 */
export function getActiveOAuthProvider(): string | null {
  try {
    return getStoredOAuthConnections()[0]?.providerId ?? null
  } catch (error) {
    logError(error)
    return null
  }
}

/** 兼容旧调用：新结构无全局 active，仅确保该凭证已迁移。 */
export function setActiveOAuthProvider(providerId: string): void {
  const credentials = getOAuthCredentials(providerId)
  if (credentials) {
    saveOAuthCredentials(providerId, credentials)
  }
}

/** 保存 OAuth 凭证到其 API provider 同名连接。 */
export function saveOAuthCredentials(
  providerId: string,
  credentials: OAuthCredentials,
): { success: boolean; warning?: string } {
  try {
    migrateLegacyCredentials()
    const provider = getOAuthProvider(providerId)
    const connectionId = provider?.apiProvider ?? providerId
    const result = setAuthConfigOAuth(connectionId, providerId, credentials as AuthOAuthCredentials)
    clearOAuthCredentialsCache()

    logEvent(result.success ? 'zy_oauth_credentials_saved' : 'zy_oauth_credentials_save_failed', {
      providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return result
  } catch (error) {
    logError(error)
    logEvent('zy_oauth_credentials_save_exception', {
      providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: false, warning: 'Failed to save OAuth credentials' }
  }
}

export function removeOAuthCredentials(providerId: string): void {
  try {
    migrateLegacyCredentials()
    const connection = getConnectionByProviderId(providerId)
    if (connection) {
      removeAuthConfigOAuth(connection.connectionId)
    }
    clearOAuthCredentialsCache()
  } catch (error) {
    logError(error)
  }
}

export function clearAllOAuthCredentials(): void {
  try {
    clearAllAuthConfigOAuth()
    clearOAuthCredentialsCache()
  } catch (error) {
    logError(error)
  }
}

export function clearOAuthCredentialsCache(): void {
  getOAuthCredentials.cache?.clear?.()
}

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

export function getOAuthApiKeySyncForConnection(connectionId?: string): string | null {
  if (!connectionId) {
    return null
  }
  const connection = getConnectionById(connectionId)
  if (!connection) {
    return null
  }
  const provider = getOAuthProvider(connection.providerId)
  return provider?.getApiKey(connection.credentials) ?? null
}

export function getActiveOAuthApiKeySync(): string | null {
  const providerId = getActiveOAuthProvider()
  if (!providerId) {
    return null
  }
  const connection = getConnectionByProviderId(providerId)
  return connection
    ? (getOAuthProvider(providerId)?.getApiKey(connection.credentials) ?? null)
    : null
}

export function getOAuthProviderInfoForConnection(
  connectionId?: string,
): OAuthProviderInterface | null {
  if (!connectionId) {
    return null
  }
  const providerId = getConnectionById(connectionId)?.providerId
  return providerId ? (getOAuthProvider(providerId) ?? null) : null
}

export function getActiveOAuthProviderInfo(): OAuthProviderInterface | null {
  const providerId = getActiveOAuthProvider()
  return providerId ? (getOAuthProvider(providerId) ?? null) : null
}

export function isActiveOAuthTokenExpired(): boolean {
  const providerId = getActiveOAuthProvider()
  const credentials = providerId ? getOAuthCredentials(providerId) : null
  return credentials ? Date.now() + 5 * 60 * 1000 >= credentials.expires : false
}

export function isOAuthTokenExpiredForConnection(connectionId?: string): boolean {
  const credentials = getOAuthCredentialsForConnection(connectionId)
  return credentials ? Date.now() + 5 * 60 * 1000 >= credentials.expires : false
}

export async function refreshOAuthTokenForConnection(connectionId?: string): Promise<boolean> {
  if (!connectionId) {
    return false
  }
  const connection = getConnectionById(connectionId)
  const provider = connection ? getOAuthProvider(connection.providerId) : undefined
  if (!connection || !provider) {
    return false
  }
  try {
    saveOAuthCredentials(connection.providerId, await provider.refreshToken(connection.credentials))
    return true
  } catch (error) {
    logError(error)
    return false
  }
}

export async function refreshActiveOAuthToken(): Promise<boolean> {
  const providerId = getActiveOAuthProvider()
  const provider = providerId ? getOAuthProvider(providerId) : undefined
  const credentials = providerId ? await getOAuthCredentialsAsync(providerId) : null
  if (!providerId || !provider || !credentials) {
    return false
  }
  try {
    saveOAuthCredentials(providerId, await provider.refreshToken(credentials))
    return true
  } catch (error) {
    logError(error)
    return false
  }
}
