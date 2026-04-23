export type UltrareviewQuotaResponse = {
  reviews_used: number
  reviews_limit: number
  reviews_remaining: number
  is_overage: boolean
}

/**
 * 查看超审查配额用于显示和提醒决策。消费
 * 在服务端的会话创建时发生。非订阅者或端点
 * 出错时返回 null。
 * 无订阅上下文 — 始终返回 null。
 */
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  return null
}
