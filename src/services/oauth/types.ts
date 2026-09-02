// 旧版 Zy 账户 OAuth 兼容类型（订阅资料、scope 与远端服务使用）。
// 多 Provider OAuth 的通用凭证和接口定义位于 providers/types.ts，支持
// Anthropic、xAI、OpenAI Codex、GitHub Copilot 及后续注册的 provider。

export interface OAuthConfig {
  clientId: string
  clientSecret?: string
  authorizationEndpoint: string
  tokenEndpoint: string
  scopes?: string[]
}

export interface OAuthProfile {
  email?: string
  name?: string
  picture?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string | null
  expiresIn?: number
  expiresAt?: number | null
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
}

export type SubscriptionType = 'free' | 'plus' | 'pro' | 'enterprise' | 'api'

export interface OAuthProfileResponse {
  email: string
  name?: string
  picture?: string
  subscription_type?: SubscriptionType
  org_id?: string
  user_id: string
}
