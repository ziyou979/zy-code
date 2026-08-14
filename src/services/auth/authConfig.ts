/**
 * 用户级认证配置读写。
 *
 * auth.json 承载命名 API 连接；settings.json 只引用连接并配置模型组合。
 *
 * 结构：
 * - 顶层 key 为连接 id → { provider?, baseUrl?, apiFormat?, apiKey?, apiKeyHelper? }
 * - OAuth 凭证直接归属于命名连接的 `oauth` 字段
 * {
 *   "dashscope": { "apiKey": "..." },
 *   "xai": {
 *     "oauth": { "provider": "xai-oauth", "access", "refresh", "expires", ... }
 *   }
 * }
 */

import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../../services/infra/slowOperations.js'

/** 旧版全局 OAuth 存储键；仅用于读取迁移，新数据不再写入。 */
export const AUTH_OAUTH_KEY = 'oauth' as const

/** 单条 OAuth 凭证（access/refresh/expires + provider 扩展字段） */
const AuthOAuthCredentialsSchema = z
  .object({
    provider: z.string().optional().describe('OAuth implementation id for this connection.'),
    access: z.string(),
    refresh: z.string(),
    expires: z.number(),
  })
  .passthrough()

const AuthProviderConfigSchema = z
  .object({
    provider: z.string().optional().describe('Registered provider used by this named connection.'),
    baseUrl: z.string().optional().describe('API base URL for this named connection.'),
    apiFormat: z
      .enum(['anthropic', 'openai-chat', 'openai-responses', 'google'])
      .optional()
      .describe('API protocol used by this named connection.'),
    apiKey: z.string().optional().describe('Provider-scoped API key.'),
    apiKeyHelper: z.string().optional().describe('Provider-scoped command that prints an API key.'),
    oauth: AuthOAuthCredentialsSchema.optional().describe(
      'OAuth credentials owned by this named connection.',
    ),
  })
  .passthrough()

/** auth.json 的 oauth 块 */
const AuthOAuthStoreSchema = z
  .object({
    activeProvider: z.string().nullable().optional(),
    credentials: z.record(z.string(), AuthOAuthCredentialsSchema).optional().default({}),
  })
  .passthrough()

export type AuthProviderConfig = z.infer<typeof AuthProviderConfigSchema>
export type AuthOAuthCredentials = z.infer<typeof AuthOAuthCredentialsSchema>
export type AuthOAuthStore = {
  activeProvider?: string | null
  credentials: Record<string, AuthOAuthCredentials>
}

/**
 * 解析后的 auth.json：
 * - 普通 provider 条目：`AuthProviderConfig`
 * - 可选 `oauth`：多 Provider OAuth 登录态
 */
export type AuthConfig = {
  [providerId: string]: AuthProviderConfig | AuthOAuthStore | undefined
} & {
  oauth?: AuthOAuthStore
}

export type AuthOAuthConnection = {
  connectionId: string
  providerId?: string
  credentials: AuthOAuthCredentials
}

export function getAuthConfigPath(): string {
  return join(getZyConfigHomeDir(), 'auth.json')
}

/** 判断是否为 oauth 存储块（必须带 credentials 字段，避免与普通 provider 条目混淆） */
export function isAuthOAuthStore(value: unknown): value is AuthOAuthStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'credentials')) {
    return false
  }
  return AuthOAuthStoreSchema.safeParse(value).success
}

export function parseAuthConfig(value: unknown): AuthConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>

  // 拒绝旧版 providers 包装层
  if (Object.hasOwn(raw, 'providers')) {
    return null
  }

  const result: AuthConfig = {}

  if (Object.hasOwn(raw, AUTH_OAUTH_KEY)) {
    const oauthResult = AuthOAuthStoreSchema.safeParse(raw[AUTH_OAUTH_KEY])
    if (!oauthResult.success) {
      return null
    }
    result.oauth = {
      activeProvider: oauthResult.data.activeProvider ?? null,
      credentials: oauthResult.data.credentials ?? {},
    }
  }

  for (const [key, entry] of Object.entries(raw)) {
    if (key === AUTH_OAUTH_KEY) {
      continue
    }
    const parsed = AuthProviderConfigSchema.safeParse(entry)
    if (!parsed.success) {
      return null
    }
    result[key] = parsed.data
  }

  return result
}

export function loadAuthConfigFromPath(path: string): AuthConfig | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return parseAuthConfig(safeParseJSON(raw, false))
  } catch {
    return null
  }
}

export function loadAuthConfig(): AuthConfig | null {
  return loadAuthConfigFromPath(getAuthConfigPath())
}

/**
 * 读取磁盘上的 auth.json 原始对象（解析失败或不存在时返回空对象）。
 * 写回时用此保留未知字段，避免丢数据。
 */
export function readAuthConfigRaw(): Record<string, unknown> {
  try {
    const raw = readFileSync(getAuthConfigPath(), 'utf-8')
    const parsed = jsonParse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 文件不存在或损坏
  }
  return {}
}

/**
 * 将完整对象写回 auth.json（权限 0600）。
 * 调用方负责合并已有内容。
 */
export function writeAuthConfigRaw(data: Record<string, unknown>): {
  success: boolean
  warning?: string
} {
  try {
    const path = getAuthConfigPath()
    const dir = dirname(path)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code !== 'EEXIST') {
        throw e
      }
    }

    writeFileSync_DEPRECATED(path, jsonStringify(data, null, 2) + '\n', {
      encoding: 'utf8',
      flush: false,
    })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows 等平台可能不支持 chmod，忽略
    }
    return { success: true }
  } catch {
    return { success: false, warning: 'Failed to write auth.json' }
  }
}

/**
 * 更新 auth.json：读取 → mutator → 写回。
 * mutator 直接改 raw 对象（含 oauth 与各 provider 条目）。
 */
export function updateAuthConfigRaw(mutator: (current: Record<string, unknown>) => void): {
  success: boolean
  warning?: string
} {
  const current = readAuthConfigRaw()
  mutator(current)
  return writeAuthConfigRaw(current)
}

/** 读取 oauth 块；不存在则返回空结构 */
export function getAuthOAuthStoreFromConfig(config: AuthConfig | null): AuthOAuthStore {
  const credentials: Record<string, AuthOAuthCredentials> = {}
  let activeProvider: string | null = null

  // 旧版结构仅作兼容读取；任何后续 OAuth 写入都会迁移为连接内的 oauth。
  const legacy = config?.oauth
  if (legacy) {
    Object.assign(credentials, legacy.credentials)
    activeProvider = legacy.activeProvider ?? null
  }

  for (const connection of getAuthOAuthConnectionsFromConfig(config)) {
    if (connection.providerId) {
      credentials[connection.providerId] = connection.credentials
      activeProvider ??= connection.providerId
    }
  }
  return { activeProvider, credentials }
}

export function getAuthOAuthStore(): AuthOAuthStore {
  return getAuthOAuthStoreFromConfig(loadAuthConfig())
}

/** 枚举新版连接内 OAuth 凭证。 */
export function getAuthOAuthConnectionsFromConfig(
  config: AuthConfig | null,
): AuthOAuthConnection[] {
  if (!config) {
    return []
  }
  const result: AuthOAuthConnection[] = []
  for (const [connectionId, value] of Object.entries(config)) {
    if (connectionId === AUTH_OAUTH_KEY || !value || isAuthOAuthStore(value)) {
      continue
    }
    const oauth = (value as AuthProviderConfig).oauth
    if (!oauth) {
      continue
    }
    result.push({
      connectionId,
      providerId: oauth.provider,
      credentials: oauth,
    })
  }
  return result
}

export function getAuthOAuthConnections(): AuthOAuthConnection[] {
  return getAuthOAuthConnectionsFromConfig(loadAuthConfig())
}

/** 将 OAuth 凭证写入指定命名连接，并删除旧版全局存储。 */
export function setAuthConfigOAuth(
  connectionId: string,
  providerId: string,
  credentials: AuthOAuthCredentials,
): { success: boolean; warning?: string } {
  return updateAuthConfigRaw((current) => {
    const existing = current[connectionId]
    const entry =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
    entry.oauth = { ...credentials, provider: providerId }
    current[connectionId] = entry
    delete current[AUTH_OAUTH_KEY]
  })
}

export function removeAuthConfigOAuth(connectionId: string): {
  success: boolean
  warning?: string
} {
  return updateAuthConfigRaw((current) => {
    const existing = current[connectionId]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return
    }
    const entry = { ...(existing as Record<string, unknown>) }
    delete entry.oauth
    if (Object.keys(entry).length === 0) {
      delete current[connectionId]
    } else {
      current[connectionId] = entry
    }
  })
}

export function clearAllAuthConfigOAuth(): { success: boolean; warning?: string } {
  return updateAuthConfigRaw((current) => {
    delete current[AUTH_OAUTH_KEY]
    for (const [connectionId, existing] of Object.entries(current)) {
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        continue
      }
      const entry = { ...(existing as Record<string, unknown>) }
      if (!Object.hasOwn(entry, 'oauth')) {
        continue
      }
      delete entry.oauth
      if (Object.keys(entry).length === 0) {
        delete current[connectionId]
      } else {
        current[connectionId] = entry
      }
    }
  })
}

export function getAuthConfigForProviderFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): AuthProviderConfig | undefined {
  // oauth 是保留键，不是 API provider id
  if (!provider || !config || provider === AUTH_OAUTH_KEY) {
    return undefined
  }
  const entry = config[provider]
  if (!entry || typeof entry !== 'object') {
    return undefined
  }
  return entry as AuthProviderConfig
}

export function getAuthConfigForProvider(provider?: string | null): AuthProviderConfig | undefined {
  return getAuthConfigForProviderFromConfig(loadAuthConfig(), provider)
}

export function getAuthConfigBaseUrl(provider?: string | null): string | undefined {
  return getAuthConfigForProvider(provider)?.baseUrl
}

export function getAuthConfigApiFormat(
  provider?: string | null,
): 'anthropic' | 'openai-chat' | 'openai-responses' | 'google' | undefined {
  return getAuthConfigForProvider(provider)?.apiFormat
}

export function getAuthConfigApiKeyFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): string | undefined {
  return getAuthConfigForProviderFromConfig(config, provider)?.apiKey
}

export function getAuthConfigApiKey(provider?: string | null): string | undefined {
  const config = loadAuthConfig()
  return getAuthConfigApiKeyFromConfig(config, provider)
}

export function getAuthConfigApiKeyHelperFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): string | undefined {
  return getAuthConfigForProviderFromConfig(config, provider)?.apiKeyHelper
}

export function getAuthConfigApiKeyHelper(provider?: string | null): string | undefined {
  const config = loadAuthConfig()
  return getAuthConfigApiKeyHelperFromConfig(config, provider)
}

/**
 * 写入或更新某 provider 的 apiKey（合并进 auth.json，不覆盖其它字段）。
 * 传空字符串则删除该 provider 的 apiKey 字段。
 */
export function setAuthConfigApiKey(
  provider: string,
  apiKey: string | undefined,
): { success: boolean; warning?: string } {
  if (!provider.trim()) {
    return { success: false, warning: 'provider is required' }
  }
  return updateAuthConfigRaw((current) => {
    const existing = current[provider]
    const entry =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}

    const trimmed = apiKey?.trim()
    if (trimmed) {
      entry.apiKey = trimmed
      current[provider] = entry
      return
    }

    delete entry.apiKey
    // 条目空了则删掉整个 provider 键（保留 oauth 等结构字段）
    if (Object.keys(entry).length === 0) {
      delete current[provider]
    } else {
      current[provider] = entry
    }
  })
}

/** 写入 onboarding 产生的完整连接信息，同时保留已有 helper 等扩展字段。 */
export function setAuthConfigConnection(
  connectionId: string,
  config: Pick<AuthProviderConfig, 'provider' | 'baseUrl' | 'apiFormat' | 'apiKey'>,
): { success: boolean; warning?: string } {
  if (!connectionId.trim()) {
    return { success: false, warning: 'connection id is required' }
  }
  return updateAuthConfigRaw((current) => {
    const existing = current[connectionId]
    const entry =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== '') {
        entry[key] = key === 'apiKey' ? value.trim() : value
      }
    }
    current[connectionId] = entry
  })
}

/**
 * 清除 auth.json 中所有 provider 的 apiKey 字段（保留 apiKeyHelper / oauth）。
 * 用于 /logout 与 removeApiKey。
 */
export function clearAllAuthConfigApiKeys(): { success: boolean; warning?: string } {
  return updateAuthConfigRaw((current) => {
    for (const key of Object.keys(current)) {
      if (key === AUTH_OAUTH_KEY) {
        continue
      }
      const existing = current[key]
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        continue
      }
      const entry = { ...(existing as Record<string, unknown>) }
      if (!('apiKey' in entry)) {
        continue
      }
      delete entry.apiKey
      if (Object.keys(entry).length === 0) {
        delete current[key]
      } else {
        current[key] = entry
      }
    }
  })
}
