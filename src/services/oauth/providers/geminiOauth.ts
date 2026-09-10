/**
 * Google 订阅 OAuth（Google AI Pro/Ultra）
 *
 * 参考 CLIProxyAPI 的 antigravity provider：使用 Google Antigravity 的
 * 公开 OAuth client 走 authorization code 流程，登录后经 Code Assist 控制
 * 面接口（loadCodeAssist / onboardUser）获取 cloudaicompanionProject，
 * 推理请求由 codeAssistProviderAdapter 走 cloudcode-pa.googleapis.com 的
 * v1internal 端点消耗订阅额度。
 */

import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { tSync } from '../../../i18n/index.js'
import { oauthErrorHtml, oauthSuccessHtml } from './oauthPage.js'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
} from './types.js'

/** Google OAuth 凭证扩展字段：project 是推理请求必填项，refresh 时必须继承 */
export type GeminiOAuthCredentials = OAuthCredentials & {
  /** Code Assist cloudaicompanionProject（GCP 项目 ID） */
  project?: string
  /** 登录账号 email，仅用于状态展示 */
  email?: string
  /** 订阅档位（free-tier / legacy-tier / standard-tier 等，来源 loadCodeAssist） */
  tier?: string
}

const decode = (s: string) => atob(s)
// Antigravity 公开 OAuth client（同 CLIProxyAPI internal/auth/antigravity/constants.go）
const CLIENT_ID = decode(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
)
const CLIENT_SECRET = decode('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=')
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'
const CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com'
// onboardUser 走 daily 端点（Antigravity 控制面惯例）
const CODE_ASSIST_DAILY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
const API_VERSION = 'v1internal'
const CALLBACK_HOST = process.env.ZY_CODE_OAUTH_CALLBACK_HOST || '127.0.0.1'
// Google OAuth client 的 redirect URI 白名单精确匹配，端口不可随机分配
const CALLBACK_PORT = 51121
const CALLBACK_PATH = '/oauth-callback'
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')

/**
 * 服务端按 UA 中的 Antigravity 版本做准入校验，低于 2.9.0 会被拒绝。
 * 第一版写死 fallback 版本，不做 hub manifest 动态探测——减少外部依赖与
 * 请求指纹差异；env 覆盖作为版本收紧时的兜底手段。
 */
const DEFAULT_UA_VERSION = '2.9.1'
/** CPA 观测到的 Antigravity Hub 平台标识，请求 UA 使用该固定值 */
const UA_PLATFORM = 'darwin/arm64'

function getAntigravityVersion(): string {
  const override = process.env.ZY_CODE_GEMINI_OAUTH_UA_VERSION?.trim()
  return override || DEFAULT_UA_VERSION
}

/** 短 UA：generateContent / loadCodeAssist / userinfo 等请求使用 */
export function antigravityRequestUserAgent(): string {
  return `antigravity/hub/${getAntigravityVersion()} ${UA_PLATFORM}`
}

/** 长 UA：onboardUser 控制面请求使用（短 UA + node 客户端标识） */
function antigravityOnboardUserUserAgent(): string {
  return `${antigravityRequestUserAgent()} google-api-nodejs-client/10.3.0`
}

const X_GOOG_API_CLIENT_UA = 'gl-node/22.21.1'

/** 解析用户输入的授权码或完整回调 URL（远程机器登录场景） */
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

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  return { code: value }
}

type CallbackServerInfo = {
  server: Server
  cancelWait: () => void
  waitForCode: () => Promise<{ code: string; state: string } | null>
}

/** 启动本地回调服务器（端口被占用时直接失败，redirect URI 无法变更） */
async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
  const { createServer } = await import('node:http')

  return new Promise((resolve, reject) => {
    let settleWait: ((value: { code: string; state: string } | null) => void) | undefined
    const waitForCodePromise = new Promise<{ code: string; state: string } | null>(
      (resolveWait) => {
        let settled = false
        settleWait = (value) => {
          if (settled) return
          settled = true
          resolveWait(value)
        }
      },
    )

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '', 'http://localhost')
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthErrorHtml('Callback route not found.'))
          return
        }

        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthErrorHtml('Google authentication did not complete.', `Error: ${error}`))
          return
        }

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthErrorHtml('Missing code or state parameter.'))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthErrorHtml('State mismatch.'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(oauthSuccessHtml('Google authentication completed. You can close this window.'))
        settleWait?.({ code, state })
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal error')
      }
    })

    server.on('error', (err) => {
      reject(err)
    })

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        cancelWait: () => {
          settleWait?.(null)
        },
        waitForCode: () => waitForCodePromise,
      })
    })
  })
}

/** 发送 form-urlencoded POST 请求（Google OAuth 端点要求该编码） */
async function postForm(url: string, body: Record<string, string>): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  })

  const responseBody = await response.text()
  if (!response.ok) {
    throw new Error(
      `HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
    )
  }
  return responseBody
}

/** 发送携带 Bearer 凭证的 Code Assist 控制面 POST 请求 */
async function postCodeAssistJson(
  url: string,
  body: Record<string, unknown>,
  accessToken: string,
  userAgent: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent,
      'X-Goog-Api-Client': X_GOOG_API_CLIENT_UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${text}`)
  }
  return { status: response.status, text }
}

/** 从 loadCodeAssist / onboardUser 响应中提取 cloudaicompanionProject */
export function extractCloudaicompanionProject(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'object' && value !== null) {
      const id = (value as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim()) {
        return id.trim()
      }
    }
  }
  return ''
}

/** 取 loadCodeAssist 响应中默认 tier 的 id（onboardUser 需要该字段） */
export function defaultTierId(loadResponse: unknown): string {
  if (typeof loadResponse !== 'object' || loadResponse === null) return 'free-tier'
  const record = loadResponse as Record<string, unknown>

  if (Array.isArray(record.allowedTiers)) {
    for (const rawTier of record.allowedTiers) {
      if (typeof rawTier !== 'object' || rawTier === null) continue
      const tier = rawTier as Record<string, unknown>
      if (tier.isDefault !== true) continue
      if (typeof tier.id === 'string' && tier.id.trim()) {
        return tier.id.trim()
      }
    }
  }

  if (
    typeof record.currentTier === 'object' &&
    record.currentTier !== null &&
    typeof (record.currentTier as Record<string, unknown>).id === 'string'
  ) {
    const id = (record.currentTier as Record<string, unknown>).id as string
    if (id.trim()) return id.trim()
  }

  return 'free-tier'
}

/** 用授权码交换 token（Google 标准 form 编码端点） */
async function exchangeAuthorizationCode(code: string): Promise<TokenResponse> {
  const responseBody = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  })

  const data = JSON.parse(responseBody) as Partial<TokenResponse> & { error?: string }
  if (!data.access_token) {
    throw new Error(`Token exchange returned no access_token. body=${responseBody}`)
  }
  return data as TokenResponse
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
}

/** 获取登录账号 email（仅用于展示） */
async function fetchUserInfo(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': antigravityRequestUserAgent(),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `HTTP request failed. status=${response.status}; url=${USERINFO_URL}; body=${text}`,
    )
  }
  const info = JSON.parse(text) as { email?: string }
  return info.email?.trim() ?? ''
}

/** loadCodeAssist 获取 cloudaicompanionProject 与默认 tier；project 缺失时走 onboardUser */
async function loadCodeAssistProject(
  accessToken: string,
): Promise<{ project: string; tier: string }> {
  const { text } = await postCodeAssistJson(
    `${CODE_ASSIST_BASE_URL}/${API_VERSION}:loadCodeAssist`,
    { metadata: { ideType: 'ANTIGRAVITY' } },
    accessToken,
    antigravityRequestUserAgent(),
  )
  const loadResponse = JSON.parse(text) as unknown
  const project = extractCloudaicompanionProject(loadResponse)
  if (!project) {
    // 无项目信息时交由 onboardUser 按默认 tier 开通
    return { project: '', tier: defaultTierId(loadResponse) }
  }
  return { project, tier: defaultTierId(loadResponse) }
}

/** onboardUser 按默认 tier 开通项目并轮询直到完成（最多 5 次 × 2s） */
async function onboardUserProject(accessToken: string, tierId: string): Promise<string> {
  const body = {
    tier_id: tierId,
    metadata: {
      ide_type: 'ANTIGRAVITY',
      ide_version: getAntigravityVersion(),
      ide_name: 'antigravity',
    },
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { text } = await postCodeAssistJson(
      `${CODE_ASSIST_DAILY_BASE_URL}/${API_VERSION}:onboardUser`,
      body,
      accessToken,
      antigravityOnboardUserUserAgent(),
    )
    const data = JSON.parse(text) as Record<string, unknown>

    if (data.done === true) {
      const project = extractCloudaicompanionProject(data.response)
      if (!project) {
        throw new Error('onboardUser completed but no cloudaicompanionProject in response')
      }
      return project
    }

    // LRO 未完成，等待后重试
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error('onboardUser did not complete after 5 attempts')
}

/**
 * Google 订阅 OAuth 登录（authorization code，无 PKCE — client 要求精确 redirect URI）
 *
 * 支持浏览器自动回调 和 手动粘贴授权码两种方式。
 */
export async function loginGeminiOAuth(options: {
  onAuth: (info: { url: string; instructions?: string }) => void
  onPrompt: (prompt: OAuthPrompt) => Promise<string>
  onProgress?: (message: string) => void
  onManualCodeInput?: () => Promise<string>
}): Promise<OAuthCredentials> {
  const state = randomBytes(16).toString('hex')
  const server = await startCallbackServer(state)

  let code: string | undefined

  try {
    const authParams = new URLSearchParams({
      access_type: 'offline',
      client_id: CLIENT_ID,
      prompt: 'consent',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      state,
    })

    options.onAuth({
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions: tSync('oauth.gemini.browserInstructions'),
    })

    if (options.onManualCodeInput) {
      // 浏览器回调和手动输入竞争，先完成者生效
      let manualInput: string | undefined
      let manualError: Error | undefined
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualInput = input
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
      } else if (manualInput) {
        code = parseAndValidateCode(manualInput, state)
      }

      if (!code) {
        await manualPromise
        if (manualError) {
          throw manualError
        }
        if (manualInput) {
          code = parseAndValidateCode(manualInput, state)
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
        message: tSync('oauth.gemini.pasteCodePrompt'),
        placeholder: REDIRECT_URI,
      })
      code = parseAndValidateCode(input, state)
    }

    if (!code) {
      throw new Error('Missing authorization code')
    }

    options.onProgress?.(tSync('oauth.gemini.exchangingToken'))
    const tokens = await exchangeAuthorizationCode(code)

    options.onProgress?.(tSync('oauth.gemini.fetchingProfile'))
    const email = await fetchUserInfo(tokens.access_token)

    options.onProgress?.(tSync('oauth.gemini.loadingProject'))
    const loaded = await loadCodeAssistProject(tokens.access_token)
    let project = loaded?.project ?? ''
    const tier = loaded?.tier ?? 'free-tier'
    if (!project) {
      options.onProgress?.(tSync('oauth.gemini.onboardingProject'))
      project = await onboardUserProject(tokens.access_token, tier)
    }

    return {
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      // 提前 5 分钟过期，避免边界情况
      expires: Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000,
      project,
      email,
      tier,
    }
  } catch (error) {
    // 端口被占用时 redirect URI 无法变更，给出可操作的提示
    const code = (error as { code?: string }).code
    if (code === 'EADDRINUSE') {
      throw new Error(tSync('oauth.gemini.portInUse', { port: String(CALLBACK_PORT) }))
    }
    throw error
  } finally {
    server.server.close()
  }
}

/** 解析手动输入并校验 state（远程机器登录场景没有本地回调可校验） */
function parseAndValidateCode(input: string, expectedState: string): string {
  const parsed = parseAuthorizationInput(input)
  if (parsed.state && parsed.state !== expectedState) {
    throw new Error('OAuth state mismatch')
  }
  return parsed.code ?? ''
}

/**
 * 用 loadCodeAssist 探测订阅访问是否有效（轻量、不消耗生成配额）。
 * 401/403 视为凭证无效，网络等其他错误向上抛出由调用方决定重试。
 */
export async function verifyGeminiSubscriptionAccess(accessToken: string): Promise<boolean> {
  try {
    await postCodeAssistJson(
      `${CODE_ASSIST_BASE_URL}/${API_VERSION}:loadCodeAssist`,
      { metadata: { ideType: 'ANTIGRAVITY' } },
      accessToken,
      antigravityRequestUserAgent(),
    )
    return true
  } catch (error) {
    const status = (error as { message?: string }).message?.match(/status=(\d{3})/)?.[1]
    if (status === '401' || status === '403') {
      return false
    }
    throw error
  }
}

/**
 * 刷新 Google 订阅 OAuth token。
 *
 * Google 的 refresh_token grant 通常不返回新的 refresh_token，需保留旧值；
 * project/email/tier 是服务端识别订阅身份的扩展字段，刷新后必须继承，
 * 否则推理请求会因缺少 project 而 400。
 */
export async function refreshGeminiOAuthToken(
  credentials: GeminiOAuthCredentials,
): Promise<OAuthCredentials> {
  const responseBody = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: credentials.refresh,
  })

  const data = JSON.parse(responseBody) as Partial<TokenResponse> & { error?: string }
  if (!data.access_token) {
    throw new Error(`Token refresh returned no access_token. body=${responseBody}`)
  }

  return {
    ...credentials,
    refresh: data.refresh_token ?? credentials.refresh,
    access: data.access_token,
    // Google refresh 响应可能缺少 expires_in，按 1 小时兜底（提前 5 分钟过期）
    expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
  }
}

/** Google 订阅 OAuth Provider 实现 */
export const geminiOAuthProvider: OAuthProviderInterface = {
  id: 'gemini-oauth',
  name: 'Google AI (AI Pro/Ultra subscription)',
  usesCallbackServer: true,
  apiProvider: 'gemini-oauth',
  apiFormat: 'google',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginGeminiOAuth({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
    })
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshGeminiOAuthToken(credentials as GeminiOAuthCredentials)
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}
