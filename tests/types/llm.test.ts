/**
 * llm 类型守卫测试：类型判断函数。
 *
 * 重点关注：
 * - isAPIError 鸭子类型判断
 * - isConnectionError / isConnectionTimeoutError 构造器名判断
 * - isAbortError / createAbortError
 * - getErrorStatus / getErrorMessage / getErrorHeader 安全访问
 */
import { describe, test, expect } from 'bun:test'
import {
  isAPIError,
  isConnectionError,
  isConnectionTimeoutError,
  isAbortError,
  createAbortError,
  getErrorStatus,
  getErrorMessage,
  getErrorHeader,
  getHeader,
  LLMError,
  LLMAbortError,
  LLMConnectionError,
} from '../../src/types/llm.js'

describe('llm 类型守卫', () => {
  describe('isAPIError', () => {
    test('LLMError 实例 → true', () => {
      const err = new LLMError('rate limited', 429)
      expect(isAPIError(err)).toBe(true)
    })

    test('Error + status → true（鸭子类型）', () => {
      const err = new Error('bad request')
      ;(err as any).status = 400
      expect(isAPIError(err)).toBe(true)
    })

    test('普通 Error → false', () => {
      expect(isAPIError(new Error('oops'))).toBe(false)
    })

    test('非 Error 对象 → false', () => {
      expect(isAPIError('string error')).toBe(false)
      expect(isAPIError(null)).toBe(false)
      expect(isAPIError(undefined)).toBe(false)
    })
  })

  describe('isConnectionError', () => {
    test('LLMConnectionError → true', () => {
      expect(isConnectionError(new LLMConnectionError('conn failed'))).toBe(true)
    })

    test('Error + 构造器名 APIConnectionError → true', () => {
      const err = new Error('conn')
      Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionError' } })
      expect(isConnectionError(err)).toBe(true)
    })

    test('普通 Error → false', () => {
      expect(isConnectionError(new Error('oops'))).toBe(false)
    })
  })

  describe('isConnectionTimeoutError', () => {
    test('APIConnectionTimeoutError 构造器名 → true', () => {
      const err = new Error('timeout')
      Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionTimeoutError' } })
      expect(isConnectionTimeoutError(err)).toBe(true)
    })

    test('APIConnectionError + message 含 timeout → true', () => {
      const err = new Error('connection timeout after 10s')
      Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionError' } })
      expect(isConnectionTimeoutError(err)).toBe(true)
    })

    test('APIConnectionError + message 不含 timeout → false', () => {
      const err = new Error('connection refused')
      Object.defineProperty(err, 'constructor', { value: { name: 'APIConnectionError' } })
      expect(isConnectionTimeoutError(err)).toBe(false)
    })
  })

  describe('isAbortError / createAbortError', () => {
    test('LLMAbortError → true', () => {
      expect(isAbortError(new LLMAbortError())).toBe(true)
    })

    test('APIUserAbortError 构造器名 → true', () => {
      const err = new Error('user aborted')
      Object.defineProperty(err, 'constructor', { value: { name: 'APIUserAbortError' } })
      expect(isAbortError(err)).toBe(true)
    })

    test('createAbortError 返回 LLMAbortError 实例', () => {
      const err = createAbortError()
      expect(err).toBeInstanceOf(LLMAbortError)
      expect(isAbortError(err)).toBe(true)
    })
  })

  describe('getErrorStatus', () => {
    test('LLMError 返回 status', () => {
      expect(getErrorStatus(new LLMError('rate limit', 429))).toBe(429)
    })

    test('Error + status → status', () => {
      const err = new Error('bad')
      ;(err as any).status = 500
      expect(getErrorStatus(err)).toBe(500)
    })

    test('普通 Error → undefined', () => {
      expect(getErrorStatus(new Error('oops'))).toBeUndefined()
    })

    test('非 Error → undefined', () => {
      expect(getErrorStatus('str')).toBeUndefined()
      expect(getErrorStatus(null)).toBeUndefined()
    })
  })

  describe('getErrorMessage', () => {
    test('Error → message', () => {
      expect(getErrorMessage(new Error('test error'))).toBe('test error')
    })

    test('字符串 → 原样返回', () => {
      expect(getErrorMessage('just a string')).toBe('just a string')
    })

    test('数字 → 转为字符串', () => {
      expect(getErrorMessage(42)).toBe('42')
    })
  })

  describe('getErrorHeader', () => {
    test('LLMError 含 headers → 返回对应值', () => {
      const err = new LLMError('rate limit', 429, { 'retry-after': '120' })
      expect(getErrorHeader(err, 'retry-after')).toBe('120')
    })

    test('LLMError 不含 headers → null', () => {
      const err = new LLMError('rate limit', 429)
      expect(getErrorHeader(err, 'retry-after')).toBe(null)
    })

    test('Error + headers get 方法 → 使用 get', () => {
      const err = new Error('test')
      ;(err as any).headers = { get: (n: string) => n }
      expect(getErrorHeader(err, 'x-request-id')).toBe('x-request-id')
    })

    test('Error + headers 普通对象 → 键访问', () => {
      const err = new Error('test')
      ;(err as any).headers = { 'x-request-id': 'abc' }
      expect(getErrorHeader(err, 'x-request-id')).toBe('abc')
    })

    test('非 Error → null', () => {
      expect(getErrorHeader('str', 'header')).toBe(null)
    })
  })

  describe('getHeader（兼容 Headers 实例和普通对象）', () => {
    test('对象含 get 方法时使用 get', () => {
      const error = { headers: { get: (n: string) => `val-${n}` } }
      expect(getHeader(error as any, 'foo')).toBe('val-foo')
    })

    test('普通对象使用键访问', () => {
      const error = { headers: { 'content-type': 'application/json' } }
      expect(getHeader(error as any, 'content-type')).toBe('application/json')
    })

    test('headers 为 undefined → null', () => {
      // @ts-ignore
      expect(getHeader({}, 'foo')).toBe(null)
    })

    test('get 返回 undefined 时回退 null', () => {
      const error = { headers: { get: () => undefined } }
      expect(getHeader(error as any, 'foo')).toBe(null)
    })
  })
})
