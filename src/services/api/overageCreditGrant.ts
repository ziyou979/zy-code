import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

type CachedGrantEntry = {
  info: OverageCreditGrantInfo
  timestamp: number
}

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时

/**
 * 从后端获取当前用户的超额信用赠予资格。
 * 后端解析层级特定的金额和基于角色的领取权限，
 * 因此 CLI 只读取响应而不复制该逻辑。
 */
async function fetchOverageCreditGrant(): Promise<OverageCreditGrantInfo | null> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant`
    const response = await axios.get<OverageCreditGrantInfo>(url, {
      headers: getOAuthHeaders(accessToken),
    })
    return response.data
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * 获取缓存的赠予信息。无缓存或缓存过期时返回 null。
 * 调用方在此返回 null 时不应渲染任何内容（不阻塞） —
 * refreshOverageCreditGrantCache 会懒触发以填充缓存。
 */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const cached = getGlobalConfig().overageCreditGrantCache?.[orgId]
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
  return cached.info
}

/**
 * 丢弃当前组织的缓存条目，以便下次读取时重新获取。
 * 保留其他组织的条目不变。
 */
export function invalidateOverageCreditGrantCache(): void {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const cache = getGlobalConfig().overageCreditGrantCache
  if (!cache || !(orgId in cache)) return
  saveGlobalConfig((prev) => {
    const next = { ...prev.overageCreditGrantCache }
    delete next[orgId]
    return { ...prev, overageCreditGrantCache: next }
  })
}

/**
 * 获取并缓存赠予信息。即发即弃；在增售界面即将渲染
 * 且缓存为空时调用。
 */
export async function refreshOverageCreditGrantCache(): Promise<void> {
  if (isEssentialTrafficOnly()) return
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const info = await fetchOverageCreditGrant()
  if (!info) return
  // 赠予数据未变更时跳过重写 — 避免配置写入放大
  //（inc-4552 模式）。仍刷新时间戳，以免
  // getCachedOverageCreditGrant 中基于 TTL 的过期检查
  // 在每次组件挂载时重复触发 API 调用。
  saveGlobalConfig((prev) => {
    // 从 prev（锁内新鲜）派生，而非锁前的 getGlobalConfig()
    // 读取 — saveConfigWithLock 在文件锁下从磁盘重新读取配置，
    // 所以另一个 CLI 实例可能在外部读取和锁获取之间写入了数据。
    const prevCached = prev.overageCreditGrantCache?.[orgId]
    const existing = prevCached?.info
    const dataUnchanged =
      existing &&
      existing.available === info.available &&
      existing.eligible === info.eligible &&
      existing.granted === info.granted &&
      existing.amount_minor_units === info.amount_minor_units &&
      existing.currency === info.currency
    // 数据未变更且时间戳仍新鲜时，完全跳过写入
    if (dataUnchanged && prevCached && Date.now() - prevCached.timestamp <= CACHE_TTL_MS) {
      return prev
    }
    const entry: CachedGrantEntry = {
      info: dataUnchanged ? existing : info,
      timestamp: Date.now(),
    }
    return {
      ...prev,
      overageCreditGrantCache: {
        ...prev.overageCreditGrantCache,
        [orgId]: entry,
      },
    }
  })
}

/**
 * 格式化赠予金额用于显示。金额不可用时返回 null
 *（不符合资格，或我们不支持其货币格式化）。
 */
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null
  // 目前仅支持 USD；后端未来可能扩展
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}

export type { CachedGrantEntry as OverageCreditGrantCacheEntry }
