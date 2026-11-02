/**
 * OpenAI "Sign in with ChatGPT" OAuth 流程
 *
 * 与同目录 openaiCodex.ts 的关键区别：本流程拿订阅令牌请求**公开** API
 * （api.openai.com），而 openaiCodex 走 Codex 私有后端
 * （chatgpt.com/backend-api/codex）。因此本流程不需要 WebSocket 传输、
 * zstd 压缩或 previous_response_id 续接那套私有协议适配。
 *
 * 协议依据 OpenAI 官方文档「Sign in with ChatGPT」token sharing：
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 * 要点：
 * - 首次注册用 `client_id=dynamic_agent_client` 并携带 `agent_name_hint`
 *   （仅显示元数据，非身份标识）；OpenAI 在回调中下发真实签发的 client ID，
 *   必须持久化供后续 refresh 与重新授权使用。
 * - 重新授权改用已签发的 client ID，省略 `agent_name_hint`，并回传
 *   `id_token_hint`；此时回调可能不再下发 client ID。
 * - scope 中的 `chatgpt.tokens.use.direct` 是订阅额度直连平台 API 的授权开关，
 *   缺失说明账号套餐不支持，应在登录阶段就报错。
 * - `ext_agent_host_id` 是标识 agent 主机的稳定 UUID，同一主机须始终一致。
 *
 * 准入边界：仅 ChatGPT Plus/Pro 可用；官方将开放对象限定为开源项目、本地运行
 * 的个人项目与少量精选私有应用，付费或远程托管的应用需先加入 waitlist。
 * 故登录入口仍受 feature flag 门控。
 */

import { tSync } from '../../../i18n/index.js'
import { getOrCreateAuthHostId } from '../../auth/authConfig.js'
import { fetchWithLoginCancellation, startOAuthCallbackServer } from './oauthCallbackServer.js'
import { generatePKCE } from './pkce.js'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
  OAuthSelectPrompt,
} from './types.js'

const AUTH_BASE_URL = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE_URL}/api/accounts/authorize`
const TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/oauth/token`
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

/** 订阅令牌直连平台 API 所需的 scope，缺失即代表账号不支持该能力。 */
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`

/** 订阅令牌最终发往的 API 资源，需同时出现在授权与换 token 请求中。 */
export const OPENAI_CHATGPT_API_RESOURCE = 'https://api.openai.com/v1'

/** 仅首次注册使用；令牌交换和刷新必须使用回调签发的 client ID。 */
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const AGENT_NAME_HINT = 'ZY Code'

/** 提前于真实过期时间刷新，避免请求恰好在令牌失效瞬间发出。 */
const EXPIRY_MARGIN_MS = 3 * 60 * 1000

/**
 * 凭据上的订阅标记。请求层据此裁掉订阅端点不接受的字段，
 * 而不是靠 access token 是否以 `sk-` 开头去猜凭据类型。
 */
export const CHATGPT_SUBSCRIPTION_AUTH_METHOD = 'chatgpt-subscription'

type OAuthToken = {
  access: string
  refresh: string
  expires: number
  scopes: string[]
  idToken: string
}

type TokenOperation = 'exchange' | 'refresh'

/**
 * 授权回调结果。
 *
 * `clientId` 可选：官方文档说明重新授权时回调「可能」省略 client_id，
 * 此时应沿用该账号已保存的 client ID，而不是判定为失败。
 */
type AuthorizationResult = {
  code: string
  clientId?: string
}

function randomValue(): string {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  return crypto.randomBytes(32).toString('base64url')
}

/** 在打开选择器前一次性解析文案，保证同一页面使用同一种语言。 */
export function getOpenAIChatGPTLoginPrompt(): OAuthSelectPrompt {
  return {
    message: tSync('oauth.openaiChatGPT.selectLoginMethod'),
    options: [
      {
        id: 'browser',
        label: tSync('oauth.openaiChatGPT.browserLogin'),
      },
    ],
  }
}

/** 从回调 URL 或用户粘贴的输入中解析授权结果。 */
export function parseAuthorizationInput(input: string): Partial<AuthorizationResult> & {
  state?: string
} {
  const value = input.trim()
  if (!value) {
    return {}
  }

  const readParams = (params: URLSearchParams) => ({
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    clientId: params.get('client_id')?.trim() || undefined,
  })

  try {
    return readParams(new URL(value).searchParams)
  } catch {
    // 不是完整 URL，继续按其他形态解析
  }

  if (value.includes('code=')) {
    return readParams(
      new URLSearchParams(value.includes('?') ? value.slice(value.indexOf('?') + 1) : value),
    )
  }

  return { code: value }
}

/**
 * 校验 state 并取出授权码与 client ID。
 *
 * @param savedClientId 该账号已保存的、由 OpenAI 签发的 client ID（重新授权时使用）
 */
function authorizationResultFromInput(
  input: string,
  expectedState: string,
  savedClientId?: string,
): AuthorizationResult {
  const parsed = parseAuthorizationInput(input)
  if (parsed.state && parsed.state !== expectedState) {
    throw new Error(tSync('oauth.openaiChatGPT.stateMismatch'))
  }
  if (!parsed.code) {
    throw new Error(tSync('oauth.openaiChatGPT.missingAuthorizationCode'))
  }
  return { code: parsed.code, clientId: resolveClientId(parsed.clientId, savedClientId) }
}

/**
 * 合并回调下发与已保存的 client ID。
 *
 * 官方文档：首次注册必须由回调下发 client_id，缺失即注册未完成；
 * 重新授权时回调可能省略，应沿用已保存的值；若下发值与已保存值冲突，
 * 说明账号注册归属错乱，必须拒绝而非静默替换。
 */
function resolveClientId(issued: string | undefined, saved: string | undefined): string {
  if (issued && saved && issued !== saved) {
    throw new Error(tSync('oauth.openaiChatGPT.clientIdConflict'))
  }
  const resolved = issued ?? saved
  if (!resolved) {
    throw new Error(tSync('oauth.openaiChatGPT.missingClientId'))
  }
  return resolved
}

/**
 * refresh 令牌已不可用。
 *
 * 官方文档列出的失效形态（invalid_grant / refresh_token_invalidated 等）都
 * 意味着这组凭据必须作废、重新走 OAuth，重试无意义。单独用错误类型区分，
 * 便于调用方清除凭据而不是反复重试。
 */
export class ChatGPTSubscriptionCredentialError extends Error {
  readonly requiresReauthentication = true

  constructor(message: string) {
    super(message)
    this.name = 'ChatGPTSubscriptionCredentialError'
  }
}

/** refresh 阶段出现即表示凭据已作废的错误码 */
const REFRESH_INVALIDATING_CODES = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
]

/** 读取并校验 token 响应。 */
async function readTokenResponse(
  response: Response,
  operation: TokenOperation,
  previous?: OAuthCredentials,
): Promise<OAuthToken> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const failure = new Error(
      tSync('oauth.openaiChatGPT.tokenOperationFailed', {
        operation,
        status: String(response.status),
        detail: text || response.statusText,
      }),
    )
    // 刷新失败且命中作废型错误码：标记为需重新登录，调用方据此清除凭据
    if (operation === 'refresh' && REFRESH_INVALIDATING_CODES.some((code) => text.includes(code))) {
      throw new ChatGPTSubscriptionCredentialError(failure.message)
    }
    throw failure
  }

  const rawJson = await response.json()
  const json = rawJson as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    scope?: string
  } | null

  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(
      tSync('oauth.openaiChatGPT.tokenResponseMissingFields', {
        operation,
        // 错误提示可能进入日志，绝不能把已经返回的 access/refresh token 带出。
        response: JSON.stringify({
          missing: ['access_token', 'refresh_token', 'expires_in'].filter(
            (field) => !json?.[field as keyof typeof json],
          ),
        }),
      }),
    )
  }

  // OAuth 刷新响应可省略未变化的 ID token 和 scope；沿用该会话已保存的值。
  const idToken =
    json.id_token ?? (typeof previous?.idToken === 'string' ? previous.idToken : undefined)
  if (!idToken) {
    throw new Error(
      tSync('oauth.openaiChatGPT.tokenResponseMissingFields', {
        operation,
        response: JSON.stringify({ missing: 'id_token' }),
      }),
    )
  }

  const scopes =
    typeof json.scope === 'string'
      ? json.scope.split(' ').filter(Boolean)
      : Array.isArray(previous?.scopes)
        ? previous.scopes.filter((scope): scope is string => typeof scope === 'string')
        : []
  // 授权成功但拿不到直连 scope，说明账号套餐不支持，此时继续下去只会在
  // 每次请求时失败，不如在登录阶段就给出明确提示。
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(
      tSync('oauth.openaiChatGPT.missingSubscriptionScope', { scope: DIRECT_TOKEN_SCOPE }),
    )
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    scopes,
    idToken,
  }
}

/** 用授权码换取令牌。 */
async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const response = await fetchWithLoginCancellation(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: OPENAI_CHATGPT_API_RESOURCE,
    }),
    signal,
  })

  return readTokenResponse(response, 'exchange')
}

/**
 * 刷新访问令牌。
 *
 * 刷新必须回传当初由 OpenAI 签发的 client ID；缺失说明凭据来自旧版本，
 * 只能重新登录。
 */
async function refreshAccessToken(
  refreshToken: string,
  clientId: string | undefined,
  previous: OAuthCredentials,
): Promise<OAuthToken> {
  if (!clientId) {
    throw new Error(tSync('oauth.openaiChatGPT.reconnectRequired'))
  }

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource: OPENAI_CHATGPT_API_RESOURCE,
      }),
    })
  } catch (error) {
    throw new Error(
      tSync('oauth.openaiChatGPT.tokenOperationFailed', {
        operation: 'refresh',
        status: 'network',
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  return readTokenResponse(response, 'refresh', previous)
}

/**
 * 构造浏览器授权 URL。
 *
 * 首次动态注册与重新授权的参数不同：前者用 `dynamic_agent_client` 并携带
 * `agent_name_hint`（仅此一次），后者用已签发的 client ID、省略该提示并回传
 * `id_token_hint`。混用会导致注册归属错乱。
 */
async function createAuthorizationFlow(options: {
  savedClientId?: string
  idToken?: string
  originator?: string
}): Promise<{
  verifier: string
  state: string
  url: string
}> {
  const { verifier, challenge } = await generatePKCE()
  const state = randomValue()
  const isReauthorization = Boolean(options.savedClientId)

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set(
    'client_id',
    isReauthorization ? (options.savedClientId as string) : DYNAMIC_CLIENT_ID,
  )
  if (!isReauthorization) {
    url.searchParams.set('agent_name_hint', AGENT_NAME_HINT)
  }
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', randomValue())
  url.searchParams.set('resource', OPENAI_CHATGPT_API_RESOURCE)
  // 同一主机必须始终发送同一个 ext_agent_host_id
  url.searchParams.set('ext_agent_host_id', `urn:uuid:${getOrCreateAuthHostId()}`)
  if (isReauthorization && options.idToken) {
    url.searchParams.set('id_token_hint', options.idToken)
  }
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('originator', options.originator ?? 'zy-code')

  return { verifier, state, url: url.toString() }
}

function credentialsFromToken(token: OAuthToken, clientId: string): OAuthCredentials {
  return {
    access: token.access,
    refresh: token.refresh,
    // 提前 3 分钟视为过期，避免请求在令牌失效边缘发出。
    expires: token.expires - EXPIRY_MARGIN_MS,
    clientId,
    // 保留 id_token，重新授权时作为 id_token_hint 回传
    idToken: token.idToken,
    scopes: token.scopes,
    authMethod: CHATGPT_SUBSCRIPTION_AUTH_METHOD,
  }
}

/** 使用浏览器流程登录 ChatGPT 订阅。 */
export async function loginOpenAIChatGPT(options: {
  onAuth: (info: { url: string; instructions?: string }) => void
  onPrompt: (prompt: OAuthPrompt) => Promise<string>
  onManualCodeInput?: () => Promise<string>
  originator?: string
  signal?: AbortSignal
  /**
   * 该账号已保存的凭据。存在时走重新授权：沿用其 client ID，并回传
   * id_token_hint；不存在时走首次动态注册。
   */
  existingCredentials?: OAuthCredentials
}): Promise<OAuthCredentials> {
  if (options.signal?.aborted) {
    throw new Error(tSync('oauth.loginCancelled'))
  }
  const savedClientId =
    typeof options.existingCredentials?.clientId === 'string'
      ? options.existingCredentials.clientId
      : undefined
  const savedIdToken =
    typeof options.existingCredentials?.idToken === 'string'
      ? options.existingCredentials.idToken
      : undefined

  const { verifier, state, url } = await createAuthorizationFlow({
    savedClientId,
    idToken: savedIdToken,
    originator: options.originator,
  })
  const server = await startOAuthCallbackServer({
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state,
    messages: {
      routeNotFound: tSync('oauth.openaiChatGPT.callbackRouteNotFound'),
      stateMismatch: tSync('oauth.openaiChatGPT.stateMismatch'),
      missingCode: tSync('oauth.openaiChatGPT.missingAuthorizationCode'),
      completed: tSync('oauth.openaiChatGPT.authenticationCompleted'),
      internalError: tSync('oauth.openaiChatGPT.callbackInternalError'),
    },
    // 回调下发 client ID；重新授权可省略则沿用已保存值，冲突即拒绝
    accept: (code, params): AuthorizationResult => ({
      code,
      clientId: resolveClientId(params.get('client_id')?.trim() || undefined, savedClientId),
    }),
  })
  let onAbort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(tSync('oauth.loginCancelled')))
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    if (options.signal?.aborted) {
      onAbort?.()
    }
    options.onAuth({ url, instructions: tSync('oauth.openaiChatGPT.browserInstructions') })
    const parseInput = (input: string) => authorizationResultFromInput(input, state, savedClientId)
    const manualPromise = options.onManualCodeInput
      ? Promise.resolve().then(options.onManualCodeInput).then(parseInput)
      : undefined
    const callbackPromise = server.waitForCode().then(async (callback) => {
      if (callback) {
        return callback
      }
      // 回调端口不可用时仍可通过粘贴完整 URL 登录。
      return (
        manualPromise ??
        parseInput(
          await options.onPrompt({
            message: tSync('oauth.openaiChatGPT.pasteAuthorizationCode'),
          }),
        )
      )
    })
    // 真正先到先得：浏览器成功不能继续等尚未完成的 readline/UI 手动输入。
    const result = await Promise.race([
      callbackPromise,
      ...(manualPromise ? [manualPromise] : []),
      cancelled,
    ])

    if (!result?.clientId) {
      throw new Error(tSync('oauth.loginCancelled'))
    }

    const token = await exchangeAuthorizationCode(
      result.code,
      result.clientId,
      verifier,
      options.signal,
    )
    return credentialsFromToken(token, result.clientId)
  } finally {
    if (onAbort) {
      options.signal?.removeEventListener('abort', onAbort)
    }
    server.close()
  }
}

/** 刷新 ChatGPT 订阅令牌。 */
export async function refreshOpenAIChatGPTToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const clientId = typeof credentials.clientId === 'string' ? credentials.clientId : undefined
  const token = await refreshAccessToken(credentials.refresh, clientId, credentials)
  // refreshAccessToken 已在 clientId 缺失时抛错，走到此处必然有值
  return credentialsFromToken(token, clientId ?? '')
}

/**
 * 读取该账号已保存的凭据，用于判断走首次注册还是重新授权。
 *
 * 惰性 require：oauthStorage 经 providers/index.js 反向依赖本模块，
 * 顶层静态 import 会形成循环。
 */
function readExistingCredentials(): OAuthCredentials | undefined {
  try {
    const { getOAuthCredentials } =
      require('../oauthStorage.js') as typeof import('../oauthStorage.js')
    const credentials = getOAuthCredentials('openai-chatgpt')
    return credentials?.access ? credentials : undefined
  } catch {
    // 读不到就按首次注册处理，动态注册同样能拿到 client ID
    return undefined
  }
}

/** OpenAI ChatGPT 订阅 OAuth Provider 实现 */
export const openaiChatGPTOAuthProvider: OAuthProviderInterface = {
  id: 'openai-chatgpt',
  name: 'ChatGPT (Subscription)',
  usesCallbackServer: true,
  // 共用 OpenAI 的 API 格式，独立保存身份，避免覆盖已有 Codex/API key 连接。
  apiProvider: 'openai',
  defaultConnectionId: 'openai-chatgpt',
  apiFormat: 'openai-responses',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const loginMethod = await callbacks.onSelect(getOpenAIChatGPTLoginPrompt())
    if (!loginMethod) {
      throw new Error(tSync('oauth.loginCancelled'))
    }

    return loginOpenAIChatGPT({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onManualCodeInput: callbacks.onManualCodeInput,
      signal: callbacks.signal,
      existingCredentials: readExistingCredentials(),
    })
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshOpenAIChatGPTToken(credentials)
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}
