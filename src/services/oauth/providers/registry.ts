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
import { openaiCodexOAuthProvider } from './openaiCodex.js'
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from './types.js'
import { xaiOAuthProvider } from './xai.js'

/** gemini-oauth 登录入口的发布门控（已登录用户不受影响，见 getOAuthProviders） */
const GEMINI_OAUTH_LOGIN_GATE = 'zy_gemini_oauth_login'

/** 内置 OAuth Provider 列表 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  geminiOAuthProvider,
  githubCopilotOAuthProvider,
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
 * gemini-oauth 的登录入口受 `zy_gemini_oauth_login` 门控（v1internal 为非公开
 * 接口，需要灰度开关控制暴露面）；按 id 精确获取（getOAuthProvider）不过滤，
 * 保证 flag 关闭后已登录用户仍可刷新凭证、继续使用。
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  const all = Array.from(oauthProviderRegistry.values())
  if (isGeminiOAuthLoginEnabled()) {
    return all
  }
  return all.filter((provider) => provider.id !== 'gemini-oauth')
}

/** gemini-oauth 登录入口是否开放（缓存读取，不阻塞启动） */
function isGeminiOAuthLoginEnabled(): boolean {
  // env 覆盖用于测试与灰度前的手动启用（远程 gate 不一定及时下发）
  if (isEnvTruthy(process.env.ZY_CODE_ENABLE_GEMINI_OAUTH)) {
    return true
  }
  return getFeatureValue_CACHED_MAY_BE_STALE(GEMINI_OAUTH_LOGIN_GATE, false)
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
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`)
    }
  }

  const apiKey = provider.getApiKey(creds)
  return { newCredentials: creds, apiKey }
}
