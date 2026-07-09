/**
 * getAPIErrorSeverity 测试：验证 terminal / retryable 分类正确。
 */
import { describe, expect, test } from 'bun:test'
import { getAPIErrorSeverity } from '../../../src/services/api/errors.js'

describe('getAPIErrorSeverity', () => {
  // isAPIError 使用鸭子类型：Error 实例 + 数值 status 字段
  function makeAPIError(status: number, message: string): Error {
    const err = new Error(message)
    ;(err as Error & { status: number }).status = status
    return err
  }

  // isConnectionError 检查 constructor.name === 'APIConnectionError'
  class APIConnectionError extends Error {
    constructor(message = 'Connection timeout') {
      super(message)
      this.name = 'APIConnectionError'
    }
  }

  test('terminal: 被中止的请求', () => {
    expect(getAPIErrorSeverity(new Error('Request was aborted.'))).toBe('terminal')
  })

  test('terminal: 紧急容量关闭', () => {
    expect(getAPIErrorSeverity(new Error('当前模型负载较高，请使用 /model 切换到其他模型'))).toBe('terminal')
  })

  test('terminal: 401 认证错误', () => {
    expect(getAPIErrorSeverity(makeAPIError(401, 'Unauthorized'))).toBe('terminal')
  })

  test('terminal: 403 禁止访问', () => {
    expect(getAPIErrorSeverity(makeAPIError(403, 'Forbidden'))).toBe('terminal')
  })

  test('terminal: x-api-key 错误', () => {
    expect(getAPIErrorSeverity(new Error('x-api-key is invalid'))).toBe('terminal')
  })

  test('terminal: 400 错误请求', () => {
    expect(getAPIErrorSeverity(makeAPIError(400, 'Bad request'))).toBe('terminal')
  })

  test('retryable: 429 限速', () => {
    expect(getAPIErrorSeverity(makeAPIError(429, 'Too Many Requests'))).toBe('retryable')
  })

  test('retryable: 408 超时', () => {
    expect(getAPIErrorSeverity(makeAPIError(408, 'Request Timeout'))).toBe('retryable')
  })

  test('retryable: 500 服务器错误', () => {
    expect(getAPIErrorSeverity(makeAPIError(500, 'Internal Server Error'))).toBe('retryable')
  })

  test('retryable: 529 过载', () => {
    expect(getAPIErrorSeverity(makeAPIError(529, 'Overloaded'))).toBe('retryable')
  })

  test('retryable: 连接错误', () => {
    expect(getAPIErrorSeverity(new APIConnectionError())).toBe('retryable')
  })

  test('retryable: 未知错误兜底', () => {
    expect(getAPIErrorSeverity(new Error('Something weird happened'))).toBe('retryable')
  })
})
