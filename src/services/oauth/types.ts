// OAuth Types

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
