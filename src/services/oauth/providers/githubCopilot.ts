/**
 * GitHub Copilot OAuth 流程
 *
 * 使用 GitHub 设备码流程（RFC 8628）获取 GitHub access token，
 * 然后用该 token 换取 Copilot session token。
 * Copilot session token 作为 API key 使用。
 */

import { pollOAuthDeviceCodeFlow } from './deviceCode.js'
import type {
  OAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from './types.js'

/** Copilot 特有的凭证扩展 */
type CopilotCredentials = OAuthCredentials & {
  enterpriseUrl?: string
  availableModelIds?: string[]
}

const decode = (s: string) => atob(s)
const CLIENT_ID = decode('SXYxLmI1MDdhMDhjODdlY2ZlOTg=')

const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const
const COPILOT_API_VERSION = '2026-06-01'

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  interval?: number
  expires_in: number
}

type DeviceTokenSuccessResponse = {
  access_token: string
  token_type?: string
  scope?: string
}

type DeviceTokenErrorResponse = {
  error: string
  error_description?: string
}

/** 规范化域名输入 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    return url.hostname
  } catch {
    return null
  }
}

/** 根据域名获取相关 URL */
function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  }
}

/**
 * 从 Copilot token 中解析 proxy-ep 并转换为 API base URL。
 * Token 格式: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 */
function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/)
  if (!match) return null
  const proxyHost = match[1]
  // 将 proxy.xxx 转换为 api.xxx
  const apiHost = proxyHost.replace(/^proxy\./, 'api.')
  return `https://${apiHost}`
}

/** 获取 GitHub Copilot API base URL */
export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  // 如果有 token，从中提取 base URL
  if (token) {
    const urlFromToken = getBaseUrlFromToken(token)
    if (urlFromToken) return urlFromToken
  }
  // 回退到 enterprise 或默认值
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`
  return 'https://api.individual.githubcopilot.com'
}

/** 安全地将 unknown 转为 Record */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** 判断 Copilot 模型是否可选 */
function isSelectableCopilotModel(item: Record<string, unknown>): boolean {
  const policy = asRecord(item.policy)
  const capabilities = asRecord(item.capabilities)
  const supports = asRecord(capabilities?.supports)
  return (
    item.model_picker_enabled === true &&
    policy?.state !== 'disabled' &&
    supports?.tool_calls !== false
  )
}

/** 解析可用的 Copilot 模型 ID 列表 */
function parseAvailableCopilotModelIds(raw: unknown): string[] {
  const data = asRecord(raw)?.data
  if (!Array.isArray(data)) {
    throw new Error('Invalid Copilot models response')
  }

  const ids: string[] = []
  for (const rawItem of data) {
    const item = asRecord(rawItem)
    const id = item?.id
    if (typeof id === 'string' && item && isSelectableCopilotModel(item)) {
      ids.push(id)
    }
  }
  return ids
}

/** 获取可用的 Copilot 模型列表 */
async function fetchAvailableGitHubCopilotModelIds(
  copilotToken: string,
  enterpriseDomain?: string,
): Promise<string[]> {
  const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain)
  const raw = await fetchJson(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${copilotToken}`,
      ...COPILOT_HEADERS,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
    },
    signal: AbortSignal.timeout(5000),
  })
  return parseAvailableCopilotModelIds(raw)
}

/** JSON fetch 辅助函数 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status} ${response.statusText}: ${text}`)
  }
  return response.json()
}

/** 启动 GitHub 设备码流程 */
async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
  const urls = getUrls(domain)
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'read:user',
    }),
  })

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid device code response')
  }

  const deviceCode = (data as Record<string, unknown>).device_code
  const userCode = (data as Record<string, unknown>).user_code
  const verificationUri = (data as Record<string, unknown>).verification_uri
  const interval = (data as Record<string, unknown>).interval
  const expiresIn = (data as Record<string, unknown>).expires_in

  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    (interval !== undefined && typeof interval !== 'number') ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('Invalid device code response fields')
  }

  // 验证 verification URI 是合法的 HTTP(S) URL
  let parsedUri: URL
  try {
    parsedUri = new URL(verificationUri)
  } catch {
    throw new Error('Untrusted verification_uri in device code response')
  }
  if (parsedUri.protocol !== 'https:' && parsedUri.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in device code response')
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: parsedUri.href,
    interval,
    expires_in: expiresIn,
  }
}

/** 轮询获取 GitHub access token */
async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCodeResponse,
  signal?: AbortSignal,
): Promise<string> {
  const urls = getUrls(domain)
  return pollOAuthDeviceCodeFlow<string>({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    signal,
    poll: async () => {
      const raw = await fetchJson(urls.accessTokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'GitHubCopilotChat/0.35.0',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })

      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as DeviceTokenSuccessResponse).access_token === 'string'
      ) {
        return {
          status: 'complete',
          value: (raw as DeviceTokenSuccessResponse).access_token,
        }
      }

      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as DeviceTokenErrorResponse).error === 'string'
      ) {
        const { error, error_description: description } = raw as DeviceTokenErrorResponse
        if (error === 'authorization_pending') {
          return { status: 'pending' }
        }

        if (error === 'slow_down') {
          return { status: 'slow_down' }
        }

        const descriptionSuffix = description ? `: ${description}` : ''
        return { status: 'failed', message: `Device flow failed: ${error}${descriptionSuffix}` }
      }

      return { status: 'failed', message: 'Invalid device token response' }
    },
  })
}

/** 用 GitHub access token 换取 Copilot session token */
async function refreshGitHubCopilotAccessToken(
  refreshToken: string,
  enterpriseDomain?: string,
): Promise<OAuthCredentials> {
  const domain = enterpriseDomain || 'github.com'
  const urls = getUrls(domain)

  const raw = await fetchJson(urls.copilotTokenUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
  })

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid Copilot token response')
  }

  const token = (raw as Record<string, unknown>).token
  const expiresAt = (raw as Record<string, unknown>).expires_at

  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('Invalid Copilot token response fields')
  }

  return {
    refresh: refreshToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
    enterpriseUrl: enterpriseDomain,
  }
}

/**
 * 刷新 GitHub Copilot token
 *
 * 使用存储的 GitHub refresh token（实际是 GitHub access token）
 * 重新获取 Copilot session token，并更新可用模型列表。
 */
export async function refreshGitHubCopilotToken(
  refreshToken: string,
  enterpriseDomain?: string,
): Promise<OAuthCredentials> {
  const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain)
  return {
    ...credentials,
    availableModelIds: await fetchAvailableGitHubCopilotModelIds(
      credentials.access,
      enterpriseDomain,
    ),
  }
}

/**
 * 使用设备码流程登录 GitHub Copilot
 */
export async function loginGitHubCopilot(options: {
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void
  onPrompt: (prompt: {
    message: string
    placeholder?: string
    allowEmpty?: boolean
  }) => Promise<string>
  onProgress?: (message: string) => void
  signal?: AbortSignal
}): Promise<OAuthCredentials> {
  // 询问 GitHub Enterprise URL（可选）
  const input = await options.onPrompt({
    message: 'GitHub Enterprise URL/domain (blank for github.com)',
    placeholder: 'company.ghe.com',
    allowEmpty: true,
  })

  if (options.signal?.aborted) {
    throw new Error('Login cancelled')
  }

  const trimmed = input.trim()
  const enterpriseDomain = normalizeDomain(input)
  if (trimmed && !enterpriseDomain) {
    throw new Error('Invalid GitHub Enterprise URL/domain')
  }
  const domain = enterpriseDomain || 'github.com'

  // 启动设备码流程
  const device = await startDeviceFlow(domain)
  options.onDeviceCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  })

  // 轮询获取 GitHub access token
  const githubAccessToken = await pollForGitHubAccessToken(domain, device, options.signal)

  // 用 GitHub access token 换取 Copilot session token
  options.onProgress?.('Fetching Copilot token...')
  const credentials = await refreshGitHubCopilotAccessToken(
    githubAccessToken,
    enterpriseDomain ?? undefined,
  )

  // 获取可用模型列表
  options.onProgress?.('Fetching available models...')
  return {
    ...credentials,
    availableModelIds: await fetchAvailableGitHubCopilotModelIds(
      credentials.access,
      enterpriseDomain ?? undefined,
    ),
  }
}

/** GitHub Copilot OAuth Provider 实现 */
export const githubCopilotOAuthProvider: OAuthProviderInterface = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  apiProvider: 'github-copilot',
  apiFormat: 'openai-chat',

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginGitHubCopilot({
      onDeviceCode: callbacks.onDeviceCode,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      signal: callbacks.signal,
    })
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const creds = credentials as CopilotCredentials
    return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl)
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}
