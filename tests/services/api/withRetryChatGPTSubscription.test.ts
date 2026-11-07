import { describe, expect, test } from 'bun:test'
import { CannotRetryError, withRetry } from '../../../src/services/api/withRetry.js'

async function resultOf<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const result = await generator.next()
    if (result.done) {
      return result.value
    }
  }
}

const options = {
  model: 'gpt-subscription-test',
  thinkingConfig: { type: 'disabled' as const },
  maxRetries: 1,
}

describe('withRetry ChatGPT 订阅错误', () => {
  test('订阅额度耗尽即使返回 429 也不退避重试', async () => {
    let attempts = 0
    const error = Object.assign(new Error('subscription_sharing_usage_limit_exceeded'), {
      status: 429,
    })
    const run = resultOf(
      withRetry(
        async () => ({}),
        async () => {
          attempts++
          throw error
        },
        options,
      ),
    )
    await expect(run).rejects.toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('没有 HTTP 状态码的订阅临时错误仍执行有限重试', async () => {
    let attempts = 0
    const value = await resultOf(
      withRetry(
        async () => ({}),
        async () => {
          attempts++
          if (attempts === 1) {
            throw new Error('subscription_sharing_usage_unavailable')
          }
          return 'recovered'
        },
        options,
      ),
    )
    expect(value).toBe('recovered')
    expect(attempts).toBe(2)
  })

  test('订阅准入拒绝不按普通 403 重试', async () => {
    let attempts = 0
    const error = Object.assign(new Error('subscription_sharing_user_not_eligible'), {
      status: 403,
    })
    await expect(
      resultOf(
        withRetry(
          async () => ({}),
          async () => {
            attempts++
            throw error
          },
          options,
        ),
      ),
    ).rejects.toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })
})
