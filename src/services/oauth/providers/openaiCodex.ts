/**
 * OpenAI Codex (ChatGPT OAuth) 流程
 *
 * 支持两种登录方式：
 * 1. 浏览器登录（authorization code + PKCE）
 * 2. 设备码登录（RFC 8628）— 适用于无浏览器环境
 */

import { pollOAuthDeviceCodeFlow } from './deviceCode.js'
import { oauthErrorHtml, oauthSuccessHtml } from './oauthPage.js'
import { generatePKCE } from './pkce.js'
import type {
  OAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
} from './types.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
export const OPENAI_CODEX_BROWSER_LOGIN_METHOD = 'browser'
export const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = 'device_code'
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

type OAuthToken = { access: string; refresh: string; expires: number }
type TokenOperation = 'exchange' | 'refresh'

function getCallbackHost(): string {
  return process.env.ZY_CODE_OAUTH_CALLBACK_HOST || '127.0.0.1'
}

type DeviceAuthInfo = {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
}

type DeviceTokenSuccess = {
  authorizationCode: string
  codeVerifier: string
}

type JwtPayload = {
  [JWT_CLAIM_PATH]?: {
    chatgpt_account_id?: string
  }
  [key: string]: unknown
}

/** 生成随机 state */
function createState(): string {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  return crypto.randomBytes(16).toString('hex')
}

/** 解析用户输入的授权码或完整回调 URL */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // 不是 URL
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  return { code: value }
}

/** 解码 JWT 获取 payload */
function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1] ?? ''
    const decoded = atob(payload)
    return JSON.parse(decoded) as JwtPayload
  } catch {
    return null
  }
}

/** 带取消支持的 fetch */
async function fetchWithLoginCancellation(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw new Error('Login cancelled')
    }
    throw error
  }
}

/** 读取 token 响应 */
async function readTokenResponse(
  response: Response,
  operation: TokenOperation,
): Promise<OAuthToken> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`,
    )
  }

  const rawJson = await response.json()
  const json = rawJson as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  } | null
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(
      `OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`,
    )
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

/** 用授权码交换 token */
async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const response = await fetchWithLoginCancellation(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal,
  })

  return readTokenResponse(response, 'exchange')
}

/** 刷新 access token */
async function refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    })
  } catch (error) {
    throw new Error(
      `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return readTokenResponse(response, 'refresh')
}

/** 启动设备码授权 */
async function startOpenAICodexDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.',
      )
    }
    const responseBody = await response.text().catch(() => '')
    throw new Error(
      `OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
    )
  }

  const rawJson = await response.json()
  const json = rawJson as {
    device_auth_id?: string
    user_code?: string
    interval?: number | string
  } | null
  const intervalSeconds =
    typeof json?.interval === 'string' ? Number(json.interval.trim()) : json?.interval
  if (
    !json?.device_auth_id ||
    !json.user_code ||
    typeof intervalSeconds !== 'number' ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 0
  ) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`)
  }

  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  }
}

/** 轮询设备码授权结果 */
async function pollOpenAICodexDeviceAuth(
  device: DeviceAuthInfo,
  signal?: AbortSignal,
): Promise<DeviceTokenSuccess> {
  return pollOAuthDeviceCodeFlow<DeviceTokenSuccess>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
    signal,
    poll: async () => {
      const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode,
        }),
        signal,
      })

      if (response.ok) {
        const rawJson = await response.json()
        const json = rawJson as {
          authorization_code?: string
          code_verifier?: string
        } | null
        if (!json?.authorization_code || !json.code_verifier) {
          return {
            status: 'failed',
            message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
          }
        }
        return {
          status: 'complete',
          value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier },
        }
      }

      if (response.status === 403 || response.status === 404) {
        return { status: 'pending' }
      }

      const responseBody = await response.text().catch(() => '')
      let errorCode: unknown
      try {
        const json = JSON.parse(responseBody) as { error?: string | { code?: string } } | null
        const error = json?.error
        errorCode = typeof error === 'object' ? error?.code : error
      } catch {
        // 忽略 JSON 解析错误
      }

      if (errorCode === 'deviceauth_authorization_pending') {
        return { status: 'pending' }
      }
      if (errorCode === 'slow_down') {
        return { status: 'slow_down' }
      }

      return {
        status: 'failed',
        message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
      }
    },
  })
}

/** 创建浏览器授权流程 */
async function createAuthorizationFlow(
  originator: string = 'zy-code',
): Promise<{ verifier: string; state: string; url: string }> {
  const { verifier, challenge } = await generatePKCE()
  const state = createState()

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)

  return { verifier, state, url: url.toString() }
}

type OAuthServerInfo = {
  close: () => void
  cancelWait: () => void
  waitForCode: () => Promise<{ code: string } | null>
}

/** 启动本地 OAuth 回调服务器 */
function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
  const http = require('node:http') as typeof import('node:http')

  let settleWait: ((value: { code: string } | null) => void) | undefined
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false
    settleWait = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(oauthErrorHtml('Callback route not found.'))
        return
      }
      if (url.searchParams.get('state') !== state) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(oauthErrorHtml('State mismatch.'))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(oauthErrorHtml('Missing authorization code.'))
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(oauthSuccessHtml('OpenAI authentication completed. You can close this window.'))
      settleWait?.({ code })
    } catch {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(oauthErrorHtml('Internal error while processing OAuth callback.'))
    }
  })

  return new Promise((resolve) => {
    server
      .listen(1455, getCallbackHost(), () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            settleWait?.(null)
          },
          waitForCode: () => waitForCodePromise,
        })
      })
      .on('error', () => {
        settleWait?.(null)
        resolve({
          close: () => {
            try {
              server.close()
            } catch {
              // 忽略
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        })
      })
  })
}

/** 从 access token 中提取 accountId */
function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken)
  const auth = payload?.[JWT_CLAIM_PATH]
  const accountId = auth?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
}

/** 从 token 构造凭证 */
function credentialsFromToken(token: OAuthToken): OAuthCredentials {
  const accountId = getAccountId(token.access)
  if (!accountId) {
    throw new Error('Failed to extract accountId from token')
  }

  return {
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId,
  }
}

/** 用授权码交换凭证 */
async function exchangeAuthorizationCodeForCredentials(
  code: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal))
}

/**
 * 使用设备码流程登录 OpenAI Codex
 */
export async function loginOpenAICodexDeviceCode(options: {
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void
  signal?: AbortSignal
}): Promise<OAuthCredentials> {
  const device = await startOpenAICodexDeviceAuth(options.signal)
  options.onDeviceCode({
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
  })
  const code = await pollOpenAICodexDeviceAuth(device, options.signal)
  return exchangeAuthorizationCodeForCredentials(
    code.authorizationCode,
    code.codeVerifier,
    DEVICE_REDIRECT_URI,
    options.signal,
  )
}

/**
 * 使用浏览器流程登录 OpenAI Codex
 */
export async function loginOpenAICodex(options: {
  onAuth: (info: { url: string; instructions?: string }) => void
  onPrompt: (prompt: OAuthPrompt) => Promise<string>
  onProgress?: (message: string) => void
  onManualCodeInput?: () => Promise<string>
  originator?: string
}): Promise<OAuthCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow(options.originator)
  const server = await startLocalOAuthServer(state)

  options.onAuth({ url, instructions: 'A browser window should open. Complete login to finish.' })

  let code: string | undefined
  try {
    if (options.onManualCodeInput) {
      // 浏览器回调和手动输入竞争
      let manualCode: string | undefined
      let manualError: Error | undefined
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input
          server.cancelWait()
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err))
          server.cancelWait()
        })

      const result = await server.waitForCode()

      if (manualError) {
        throw manualError
      }

      if (result?.code) {
        code = result.code
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode)
        if (parsed.state && parsed.state !== state) {
          throw new Error('State mismatch')
        }
        code = parsed.code
      }

      if (!code) {
        await manualPromise
        if (manualError) {
          throw manualError
        }
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode)
          if (parsed.state && parsed.state !== state) {
            throw new Error('State mismatch')
          }
          code = parsed.code
        }
      }
    } else {
      const result = await server.waitForCode()
      if (result?.code) {
        code = result.code
      }
    }

    // 最终回退：提示用户手动输入
    if (!code) {
      const input = await options.onPrompt({
        message: 'Paste the authorization code (or full redirect URL):',
      })
      const parsed = parseAuthorizationInput(input)
      if (parsed.state && parsed.state !== state) {
        throw new Error('State mismatch')
      }
      code = parsed.code
    }

    if (!code) {
      throw new Error('Missing authorization code')
    }

    return exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI)
  } finally {
    server.close()
  }
}

/** 刷新 OpenAI Codex OAuth token */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  return credentialsFromToken(await refreshAccessToken(refreshToken))
}

/** OpenAI Codex OAuth Provider 实现 */
export const openaiCodexOAuthProvider: OAuthProviderInterface = {
  id: 'openai-codex',
  name: 'ChatGPT Plus/Pro (Codex Subscription)',
  usesCallbackServer: true,
  apiProvider: 'openai',
  apiFormat: 'openai-chat',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const loginMethod = await callbacks.onSelect({
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: 'Browser login (default)' },
        { id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: 'Device code login (headless)' },
      ],
    })
    if (!loginMethod) {
      throw new Error('Login cancelled')
    }

    if (loginMethod === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
      return loginOpenAICodexDeviceCode({
        onDeviceCode: callbacks.onDeviceCode,
        signal: callbacks.signal,
      })
    }

    if (loginMethod !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
      throw new Error(`Unknown OpenAI Codex login method: ${loginMethod}`)
    }

    return loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
    })
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshOpenAICodexToken(credentials.refresh)
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}
