import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
type ReferralCampaign = any
type ReferralEligibilityResponse = any
type ReferralRedemptionsResponse = any
type ReferrerRewardInfo = any

// 缓存过期时间：24 小时（资格仅在订阅/实验变更时才会变化）
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

// 跟踪进行中的请求，防止重复 API 调用
let fetchInProgress: Promise<ReferralEligibilityResponse | null> | null = null

export async function fetchReferralEligibility(
  campaign: ReferralCampaign = 'zy_code_guest_pass',
): Promise<ReferralEligibilityResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/eligibility`

  const response = await axios.get(url, {
    headers,
    params: { campaign },
    timeout: 5000, // 后台获取的 5 秒超时
  })

  return response.data
}

export async function fetchReferralRedemptions(
  campaign: string = 'zy_code_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/redemptions`

  const response = await axios.get<ReferralRedemptionsResponse>(url, {
    headers,
    params: { campaign },
    timeout: 10000, // 10 秒超时
  })

  return response.data
}

/**
 * 预检用户是否可访问访客通行证功能
 * 无订阅上下文 — 始终返回 false。
 */
function shouldCheckForPasses(): boolean {
  return false
}

/**
 * 从 GlobalConfig 检查缓存的通行证资格
 * 返回当前缓存状态和缓存新鲜度
 */
export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  if (!shouldCheckForPasses()) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]

  if (!cachedEntry) {
    // 无缓存条目，需要获取
    return {
      eligible: false,
      needsRefresh: true,
      hasCache: false,
    }
  }

  const { eligible, timestamp } = cachedEntry
  const now = Date.now()
  const needsRefresh = now - timestamp > CACHE_EXPIRATION_MS

  return {
    eligible,
    needsRefresh,
    hasCache: true,
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

/**
 * 从资格缓存中获取推荐人奖励信息
 * 如果用户在 v1 活动中则返回奖励信息，否则返回 null
 */
export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.referrer_reward ?? null
}

/**
 * 从资格缓存中获取剩余通行证数量
 * 返回剩余通行证数量，如不可用则返回 null
 */
export function getCachedRemainingPasses(): number | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.remaining_passes ?? null
}

/**
 * 获取通行证资格并存储到 GlobalConfig
 * 返回获取的响应，出错时返回 null
 */
export async function fetchAndStorePassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  // 如果请求已在进行中，复用现有 Promise
  if (fetchInProgress) {
    logForDebugging('通行证：复用进行中的资格获取请求')
    return fetchInProgress
  }

  const orgId = getOauthAccountInfo()?.organizationUuid

  if (!orgId) {
    return null
  }

  // 存储 Promise 以便并发调用共享
  fetchInProgress = (async () => {
    try {
      const response = await fetchReferralEligibility()

      const cacheEntry = {
        ...response,
        timestamp: Date.now(),
      }

      saveGlobalConfig((current) => ({
        ...current,
        passesEligibilityCache: {
          ...current.passesEligibilityCache,
          [orgId]: cacheEntry,
        },
      }))

      logForDebugging(`通行证资格已缓存，组织 ${orgId}：${response.eligible}`)

      return response
    } catch (error) {
      logForDebugging('获取并缓存通行证资格失败')
      logError(error as Error)
      return null
    } finally {
      // 完成后清除 Promise
      fetchInProgress = null
    }
  })()

  return fetchInProgress
}

/**
 * 获取缓存的通行证资格数据，或在需要时获取
 * 所有资格检查的主入口
 *
 * 此函数从不阻塞网络请求 — 立即返回缓存数据，
 * 并在需要时后台获取。冷启动（无缓存）时返回 null，
 * 通行证命令直到下次会话才可用。
 */
export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  if (!shouldCheckForPasses()) {
    return null
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return null
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  const now = Date.now()

  // 无缓存 — 触发后台获取并返回 null（非阻塞）
  // 本次会话通行证命令不可用，但下次会话将可用
  if (!cachedEntry) {
    logForDebugging('通行证：无缓存，后台获取资格（本次会话命令不可用）')
    void fetchAndStorePassesEligibility()
    return null
  }

  // 缓存存在但已过期 — 返回过期缓存并触发后台刷新
  if (now - cachedEntry.timestamp > CACHE_EXPIRATION_MS) {
    logForDebugging('通行证：缓存已过期，返回缓存数据并后台刷新')
    void fetchAndStorePassesEligibility() // 后台刷新
    const { timestamp, ...response } = cachedEntry
    return response as ReferralEligibilityResponse
  }

  // 缓存新鲜 — 立即返回
  logForDebugging('通行证：使用新鲜缓存的资格数据')
  const { timestamp, ...response } = cachedEntry
  return response as ReferralEligibilityResponse
}

/**
 * 启动时预取通行证资格
 */
export async function prefetchPassesEligibility(): Promise<void> {
  // 如果非必要流量被禁用，跳过网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  void getCachedOrFetchPassesEligibility()
}
