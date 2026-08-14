import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * policy limits API 响应的 schema。
 * 只包含被阻止的策略；缺少某个策略 key 即表示允许。
 */
export const PolicyLimitsResponseSchema = lazySchema(() =>
  z.object({
    restrictions: z.record(z.string(), z.object({ allowed: z.boolean() })),
  }),
)

export type PolicyLimitsResponse = z.infer<ReturnType<typeof PolicyLimitsResponseSchema>>

/**
 * 获取 policy limits 的结果。
 */
export type PolicyLimitsFetchResult = {
  success: boolean
  restrictions?: PolicyLimitsResponse['restrictions'] | null // null means 304 Not Modified (cache is valid)
  etag?: string
  error?: string
  skipRetry?: boolean // If true, don't retry on failure (e.g., auth errors)
}
