/**
 * 服务端辅助接口（policy-limits / remote-managed-settings / settings-sync）
 * 共用的重试循环骨架。
 *
 * 语义与三处原有实现逐字对齐：
 * - 成功或 skipRetry（如认证错误）立即返回
 * - 耗尽 maxRetries 后返回最后一个结果（fail-open，不抛错）
 * - 退避计算复用 withRetry.getRetryDelay
 */
import { getRetryDelay } from '../api/withRetry.js'
import { sleep } from '../../utils/sleep.js'

export type RetryableResult = {
  success: boolean
  /** true 时不可重试（例如认证错误），立即返回该结果 */
  skipRetry?: boolean
}

export type RetryLoopOptions<T extends RetryableResult> = {
  /** 最大重试次数（总尝试次数为 maxRetries + 1） */
  maxRetries: number
  /** 单次尝试；attempt 从 1 开始 */
  fetchOnce: (attempt: number) => Promise<T>
  /** 每次重试等待前的回调（记录日志用） */
  onRetry?: (attempt: number, delayMs: number) => void
}

export async function retryWithBackoffLoop<T extends RetryableResult>(
  options: RetryLoopOptions<T>,
): Promise<T> {
  let lastResult: T | null = null

  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
    lastResult = await options.fetchOnce(attempt)

    if (lastResult.success) {
      return lastResult
    }

    if (lastResult.skipRetry) {
      return lastResult
    }

    if (attempt > options.maxRetries) {
      return lastResult
    }

    const delayMs = getRetryDelay(attempt)
    options.onRetry?.(attempt, delayMs)
    await sleep(delayMs)
  }

  // 循环必然在 attempt > maxRetries 分支返回；此处仅为类型收窄
  return lastResult!
}
