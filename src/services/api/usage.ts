import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getZyAIOAuthTokens, hasProfileScope } from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getZyCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

export type RateLimit = {
  utilization: number | null // 0 到 100 的百分比
  resets_at: string | null // ISO 8601 时间戳
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

export async function fetchUtilization(): Promise<Utilization | null> {
  // 无订阅上下文 — 跳过 API 调用
  if (!hasProfileScope()) {
    return {}
  }

  // OAuth 令牌过期时跳过 API 调用，避免 401 错误
  const tokens = getZyAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`认证错误：${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getZyCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 秒超时
  })

  return response.data
}
