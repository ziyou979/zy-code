/**
 * xAI Grok OAuth（SuperGrok / X Premium+ 订阅）
 *
 * 使用 OAuth 2.0 Device Code 流程登录 accounts.x.ai，
 * 无需 XAI_API_KEY；token 走 xAI Responses API（api.x.ai）。
 *
 * 协议细节对齐 Hermes `xai-oauth` 与 xAI 公开 OIDC discovery。
 */

import { tSync } from '../../../i18n/index.js'
import { pollOAuthDeviceCodeFlow } from './deviceCode.js'
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from './types.js'

/** 与 Hermes / OpenCode 共用的公开 xAI CLI OAuth client */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
export const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const DEFAULT_XAI_API_BASE_URL = 'https://api.x.ai/v1'
/** discovery 失败时的 token 端点回退 */
const DEFAULT_XAI_TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth2/token`
/** expires_in 缺失时的默认有效期（秒） */
const DEFAULT_EXPIRES_IN_SECONDS = 3600

/** 一次性解析登录进度文案，避免登录期间切换语言造成同一流程中英混杂。 */
export function getXaiOAuthProgressMessages(): {
  discoveringEndpoints: string
  requestingDeviceCode: string
  waitingForAuthorization: string
} {
  return {
    discoveringEndpoints: tSync('oauth.xai.discoveringEndpoints'),
    requestingDeviceCode: tSync('oauth.xai.requestingDeviceCode'),
    waitingForAuthorization: tSync('oauth.deviceCodeWaiting'),
  }
}

/** xAI OAuth 凭证扩展：缓存 token_endpoint 避免每次 refresh 都做 discovery */
export type XaiOAuthCredentials = OAuthCredentials & {
  tokenEndpoint?: string
  idToken?: string
}

type OidcDiscovery = {
  authorization_endpoint: string
  token_endpoint: string
}

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

type TokenSuccessResponse = {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  token_type?: string
}

type TokenErrorResponse = {
  error?: string
  error_description?: string
}

/** 校验 OAuth 端点必须是 https + x.ai 域名，防止 MITM 后凭据被写到恶意 URL */
export function validateXaiOAuthEndpoint(url: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(tSync('oauth.xai.invalidEndpointUrl', { field, url }))
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(tSync('oauth.xai.endpointMustUseHttps', { field, url }))
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(tSync('oauth.xai.invalidEndpointHost', { field, host }))
  }
  return url
}

/** 从 JWT payload 读取 exp（秒级 epoch）；失败返回 null */
function readJwtExpSeconds(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = parts[1] ?? ''
    // 将 base64url 转换为 base64
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof decoded.exp === 'number' && Number.isFinite(decoded.exp) ? decoded.exp : null
  } catch {
    return null
  }
}

/** 计算 access token 过期时间戳（ms） */
function resolveExpiresAtMs(accessToken: string, expiresIn?: number): number {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000
  }
  const expSec = readJwtExpSeconds(accessToken)
  if (expSec !== null) {
    return expSec * 1000
  }
  return Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000
}

function credentialsFromTokenResponse(
  payload: TokenSuccessResponse,
  previousRefresh?: string,
  tokenEndpoint?: string,
): XaiOAuthCredentials {
  const access = payload.access_token?.trim()
  if (!access) {
    throw new Error(tSync('oauth.xai.missingAccessToken'))
  }
  const refresh = (payload.refresh_token || previousRefresh || '').trim()
  if (!refresh) {
    throw new Error(tSync('oauth.xai.missingRefreshToken'))
  }

  return {
    access,
    refresh,
    expires: resolveExpiresAtMs(access, payload.expires_in),
    tokenEndpoint,
    idToken: payload.id_token?.trim() || undefined,
  }
}

/** OIDC discovery：拿到 authorization / token 端点 */
export async function discoverXaiOAuth(timeoutMs = 15_000): Promise<OidcDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(tSync('oauth.xai.discoveryFailed', { status: response.status }))
  }

  const raw = (await response.json()) as {
    authorization_endpoint?: string
    token_endpoint?: string
  }
  const authorization_endpoint = raw.authorization_endpoint?.trim() ?? ''
  const token_endpoint = raw.token_endpoint?.trim() ?? ''
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error(tSync('oauth.xai.discoveryMissingEndpoints'))
  }

  return {
    authorization_endpoint: validateXaiOAuthEndpoint(
      authorization_endpoint,
      'authorization_endpoint',
    ),
    token_endpoint: validateXaiOAuthEndpoint(token_endpoint, 'token_endpoint'),
  }
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
  const response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      tSync('oauth.xai.deviceCodeRequestFailed', {
        status: response.status,
        detail: text ? `: ${text}` : '',
      }),
    )
  }

  const raw = (await response.json()) as Partial<DeviceCodeResponse>
  if (
    !raw.device_code ||
    !raw.user_code ||
    !raw.verification_uri ||
    typeof raw.expires_in !== 'number' ||
    typeof raw.interval !== 'number'
  ) {
    throw new Error(tSync('oauth.xai.invalidDeviceCodeResponse', { response: JSON.stringify(raw) }))
  }

  return {
    device_code: raw.device_code,
    user_code: raw.user_code,
    verification_uri: raw.verification_uri,
    verification_uri_complete: raw.verification_uri_complete,
    expires_in: raw.expires_in,
    interval: raw.interval,
  }
}

async function pollDeviceToken(
  tokenEndpoint: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  signal?: AbortSignal,
): Promise<TokenSuccessResponse> {
  return pollOAuthDeviceCodeFlow<TokenSuccessResponse>({
    intervalSeconds,
    expiresInSeconds,
    signal,
    poll: async () => {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: XAI_OAUTH_CLIENT_ID,
          device_code: deviceCode,
        }),
        signal,
      })

      if (response.ok) {
        const payload = (await response.json()) as TokenSuccessResponse
        if (!payload.access_token) {
          return {
            status: 'failed',
            message: tSync('oauth.xai.deviceTokenMissingAccessToken'),
          }
        }
        if (!payload.refresh_token) {
          return {
            status: 'failed',
            message: tSync('oauth.xai.deviceTokenMissingRefreshToken'),
          }
        }
        return { status: 'complete' as const, value: payload }
      }

      let errorPayload: TokenErrorResponse = {}
      try {
        errorPayload = (await response.json()) as TokenErrorResponse
      } catch {
        const text = await response.text().catch(() => '')
        return {
          status: 'failed',
          message: tSync('oauth.xai.deviceTokenPollingHttpFailed', {
            status: response.status,
            detail: text ? `: ${text}` : '',
          }),
        }
      }

      const errorCode = errorPayload.error ?? ''
      if (errorCode === 'authorization_pending') {
        return { status: 'pending' }
      }
      if (errorCode === 'slow_down') {
        return { status: 'slow_down' }
      }

      const description =
        errorPayload.error_description || errorPayload.error || `HTTP ${response.status}`
      return {
        status: 'failed',
        message: tSync('oauth.xai.deviceTokenPollingFailed', { detail: description }),
      }
    },
  })
}

/**
 * 执行 xAI Device Code 登录，返回可持久化的凭证。
 */
export async function loginXaiOAuth(options: {
  onDeviceCode: OAuthLoginCallbacks['onDeviceCode']
  onProgress?: OAuthLoginCallbacks['onProgress']
  signal?: AbortSignal
}): Promise<XaiOAuthCredentials> {
  const progressMessages = getXaiOAuthProgressMessages()
  if (options.signal?.aborted) {
    throw new Error(tSync('oauth.loginCancelled'))
  }

  options.onProgress?.(progressMessages.discoveringEndpoints)
  let tokenEndpoint = DEFAULT_XAI_TOKEN_ENDPOINT
  try {
    const discovery = await discoverXaiOAuth()
    tokenEndpoint = discovery.token_endpoint
  } catch {
    // discovery 失败时使用已知默认 token 端点（仍校验域名）
    tokenEndpoint = validateXaiOAuthEndpoint(DEFAULT_XAI_TOKEN_ENDPOINT, 'token_endpoint')
  }

  options.onProgress?.(progressMessages.requestingDeviceCode)
  const device = await requestDeviceCode(options.signal)

  // 优先 verification_uri_complete（URL 已嵌入 user_code）
  const verificationUri = device.verification_uri_complete?.trim() || device.verification_uri

  options.onDeviceCode({
    userCode: device.user_code,
    verificationUri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  })

  options.onProgress?.(progressMessages.waitingForAuthorization)
  const tokenPayload = await pollDeviceToken(
    tokenEndpoint,
    device.device_code,
    device.interval,
    device.expires_in,
    options.signal,
  )

  return credentialsFromTokenResponse(tokenPayload, undefined, tokenEndpoint)
}

/**
 * 用 refresh_token 换取新的 access token。
 *
 * HTTP 403 多为订阅档位/白名单限制（非 token 过期），错误信息会说明改用 API Key。
 */
export async function refreshXaiOAuthToken(
  credentials: XaiOAuthCredentials,
): Promise<XaiOAuthCredentials> {
  const refreshToken = credentials.refresh?.trim()
  if (!refreshToken) {
    throw new Error(tSync('oauth.xai.refreshTokenMissing'))
  }

  let tokenEndpoint = credentials.tokenEndpoint?.trim() || DEFAULT_XAI_TOKEN_ENDPOINT
  try {
    tokenEndpoint = validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint')
  } catch {
    // 缓存的 endpoint 无效时重新 discovery
    const discovery = await discoverXaiOAuth()
    tokenEndpoint = discovery.token_endpoint
  }

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    if (response.status === 403) {
      throw new Error(
        tSync('oauth.xai.refreshForbidden', {
          detail: detail ? ` ${tSync('oauth.xai.responseDetail', { detail })}` : '',
        }),
      )
    }
    throw new Error(
      tSync('oauth.xai.refreshFailed', {
        status: response.status,
        detail: detail ? `: ${detail}` : '',
      }),
    )
  }

  const payload = (await response.json()) as TokenSuccessResponse
  return credentialsFromTokenResponse(payload, refreshToken, tokenEndpoint)
}

/** xAI Grok OAuth Provider 实现 */
export const xaiOAuthProvider: OAuthProviderInterface = {
  id: 'xai-oauth',
  name: 'xAI Grok OAuth (SuperGrok / X Premium+)',
  apiProvider: 'xai',
  // Grok 订阅路径优先走 Responses API（与 Hermes codex_responses 一致）
  apiFormat: 'openai-responses',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginXaiOAuth({
      onDeviceCode: callbacks.onDeviceCode,
      onProgress: callbacks.onProgress,
      signal: callbacks.signal,
    })
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshXaiOAuthToken(credentials as XaiOAuthCredentials)
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}
