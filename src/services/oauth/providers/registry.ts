/**
 * OAuth Provider 注册表
 *
 * 参考 pi 的注册表模式，支持内置 provider 和自定义注册。
 * 新增 provider 只需实现 OAuthProviderInterface 并加入 BUILT_IN_OAUTH_PROVIDERS。
 */

import { anthropicOAuthProvider } from './anthropic.js'
import { githubCopilotOAuthProvider } from './githubCopilot.js'
import { openaiCodexOAuthProvider } from './openaiCodex.js'
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInterface } from './types.js'

/** 内置 OAuth Provider 列表 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
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

/** 获取所有已注册的 OAuth Provider */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return Array.from(oauthProviderRegistry.values())
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
