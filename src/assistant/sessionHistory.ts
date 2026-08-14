import axios from 'axios'
import { getOauthConfig } from '../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../services/teleport/api.js'
import type { WireMessage } from '../types/index.js'
import { logForDebugging } from '../services/infra/debug.js'
export const HISTORY_PAGE_SIZE = 100

export type HistoryPage = {
  /** 当前页内按时间先后排列。 */
  events: WireMessage[]
  /** 当前页最早的事件 ID，作为查询更早一页时的 before_id 游标。 */
  firstId: string | null
  /** 为 true 时表示仍有更早的事件。 */
  hasMore: boolean
}

type SessionEventsResponse = {
  data: WireMessage[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

export type HistoryAuthCtx = {
  baseUrl: string
  headers: Record<string, string>
}

/** 一次性准备认证信息、headers 和 base URL，供各页复用。 */
export async function createHistoryAuthCtx(sessionId: string): Promise<HistoryAuthCtx> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    baseUrl: `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    },
  }
}

async function fetchPage(
  ctx: HistoryAuthCtx,
  params: Record<string, string | number | boolean>,
  label: string,
): Promise<HistoryPage | null> {
  const resp = await axios
    .get<SessionEventsResponse>(ctx.baseUrl, {
      headers: ctx.headers,
      params,
      timeout: 15000,
      validateStatus: () => true,
    })
    .catch(() => null)
  if (!resp || resp.status !== 200) {
    logForDebugging(`[${label}] HTTP ${resp?.status ?? 'error'}`)
    return null
  }
  return {
    events: Array.isArray(resp.data.data) ? resp.data.data : [],
    firstId: resp.data.first_id,
    hasMore: resp.data.has_more,
  }
}

/**
 * 通过 anchor_to_latest 获取最新一页，即最后 `limit` 个事件，并按时间先后排列。
 * has_more=true 表示仍有更早的事件。
 */
export async function fetchLatestEvents(
  ctx: HistoryAuthCtx,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return fetchPage(ctx, { limit, anchor_to_latest: true }, 'fetchLatestEvents')
}

/** 获取 `beforeId` 游标之前紧邻的一页事件。 */
export async function fetchOlderEvents(
  ctx: HistoryAuthCtx,
  beforeId: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return fetchPage(ctx, { limit, before_id: beforeId }, 'fetchOlderEvents')
}
