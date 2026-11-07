/**
 * OAuth Provider 注册表
 *
 * 参考 pi 的注册表模式，支持内置 provider 和自定义注册。
 * 新增 provider 只需实现 OAuthProviderInterface 并加入 BUILT_IN_OAUTH_PROVIDERS。
 */

import { anthropicOAuthProvider } from './anthropic.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import { isEnvTruthy } from '../../infra/envUtils.js'
import { geminiOAuthProvider } from './geminiOauth.js'
import { githubCopilotOAuthProvider } from './githubCopilot.js'
import { openaiChatGPTOAuthProvider } from './openaiChatGPT.js'
import { openaiCodexOAuthProvider } from './openaiCodex.js'
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from './types.js'
import { xaiOAuthProvider } from './xai.js'

/** gemini-oauth 登录入口的发布门控（已登录用户不受影响，见 getOAuthProviders） */
const GEMINI_OAUTH_LOGIN_GATE = 'zy_gemini_oauth_login'

/**
 * Sign in with ChatGPT 登录入口的发布门控。
 *
 * 该能力是 OpenAI 正式文档化的公开接口（Sign in with ChatGPT token sharing），
 * 但有真实准入边界：仅 ChatGPT Plus/Pro 可用，且官方把开放对象限定为开源项目、
 * 本地运行的个人项目与少量精选私有应用；付费或远程托管的应用需先加入 waitlist。
 * 默认关闭以控制暴露面，待准入条件确认后再放量。
 */
const CHATGPT_SUBSCRIPTION_LOGIN_GATE = 'zy_chatgpt_subscription_login'

/** 登录入口受 flag 门控的 provider 及其开关 */
const GATED_LOGIN_PROVIDER_FLAGS: Record<string, { gate: string; envOverride: string }> = {
  'gemini-oauth': { gate: GEMINI_OAUTH_LOGIN_GATE, envOverride: 'ZY_CODE_ENABLE_GEMINI_OAUTH' },
  'openai-chatgpt': {
    gate: CHATGPT_SUBSCRIPTION_LOGIN_GATE,
    envOverride: 'ZY_CODE_ENABLE_CHATGPT_LOGIN',
  },
}

/** 内置 OAuth Provider 列表 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  geminiOAuthProvider,
  githubCopilotOAuthProvider,
  openaiChatGPTOAuthProvider,
  openaiCodexOAuthProvider,
  xaiOAuthProvider,
]

/** Provider 注册表 Map */
const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
  BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
)

/** 按 ID 获取 OAuth Provider */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return oauthProviderRegistry.get(id)
}

/** 注册自定义 OAuth Provider */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
  oauthProviderRegistry.set(provider.id, provider)
}

/**
 * 注销 OAuth Provider。
 *
 * 如果是内置 provider，恢复内置实现；
 * 自定义 provider 则完全移除。
 */
export function unregisterOAuthProvider(id: string): void {
  const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id)
  if (builtInProvider) {
    oauthProviderRegistry.set(id, builtInProvider)
    return
  }
  oauthProviderRegistry.delete(id)
}

/** 重置为内置 provider 列表 */
export function resetOAuthProviders(): void {
  oauthProviderRegistry.clear()
  for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
    oauthProviderRegistry.set(provider.id, provider)
  }
}

/**
 * 获取所有已注册的 OAuth Provider。
 *
 * 部分 provider 的登录入口受 flag 门控：gemini-oauth 走非公开的 v1internal
 * 接口，openai-chatgpt 的公开订阅直连协议仍有准入条件，都需要灰度开关
 * 控制暴露面。按 id 精确获取（getOAuthProvider）不过滤，保证 flag 关闭后
 * 已登录用户仍可刷新凭证、继续使用。
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return getRegisteredOAuthProviders().filter((provider) => isProviderLoginEnabled(provider.id))
}

/**
 * 返回完整注册表，不应用登录入口的发布门控。
 *
 * 仅用于读取既有凭据、迁移和刷新；UI 登录列表必须继续使用 getOAuthProviders()。
 */
export function getRegisteredOAuthProviders(): OAuthProviderInterface[] {
  return Array.from(oauthProviderRegistry.values())
}

/** provider 的登录入口是否开放：不在门控表内、或对应 flag 已开启。 */
function isProviderLoginEnabled(providerId: string): boolean {
  const flag = GATED_LOGIN_PROVIDER_FLAGS[providerId]
  if (!flag) {
    return true
  }
  // env 覆盖用于测试与灰度前的手动启用（远程 gate 不一定及时下发）
  if (isEnvTruthy(process.env[flag.envOverride])) {
    return true
  }
  return getFeatureValue_CACHED_MAY_BE_STALE(flag.gate, false)
}

/** provider 刷新失败时用于标记「凭据已作废、需重新登录」的结构化标志 */
const REAUTH_REQUIRED_FLAG = 'requiresReauthentication'

/** 判断错误是否表示凭据已作废（而非临时故障）。 */
export function isCredentialInvalidatedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<string, unknown>)[REAUTH_REQUIRED_FLAG] === true
  )
}

/**
 * 获取 Provider 的 API key（自动刷新过期 token）。
 *
 * @returns 包含新凭证和 API key 的对象，或 null（无凭证）
 * @throws 刷新失败时抛出错误
 */
export async function getOAuthApiKey(
  providerId: OAuthProviderId,
  credentials: OAuthCredentials,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string }> {
  const provider = getOAuthProvider(providerId)
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`)
  }

  let creds = credentials

  // 过期则刷新
  if (Date.now() >= creds.expires) {
    try {
      creds = await provider.refreshToken(creds)
    } catch (error) {
      // provider 标记凭据已作废（如 refresh token 被吊销）时保留该信号，
      // 让调用方能清除凭据并要求重新登录，而不是当成临时故障反复重试。
      if (isCredentialInvalidatedError(error)) {
        throw error
      }
      throw new Error(`Failed to refresh OAuth token for ${providerId}`)
    }
  }

  const apiKey = provider.getApiKey(creds)
  return { newCredentials: creds, apiKey }
}
