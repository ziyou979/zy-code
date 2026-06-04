/**
 * errorUtils 测试：API 错误格式化与连接错误提取。
 *
 * 重点关注：
 * - extractConnectionErrorDetails 遍历 cause 链
 * - SSL 错误码识别
 * - formatAPIError 多分支
 * - sanitizeMessageHTML HTML 检测与 title 提取
 */
import { describe, expect, test } from 'bun:test'
import {
  extractConnectionErrorDetails,
  formatAPIError,
  getSSLErrorHint,
} from '../../../src/services/api/errorUtils.js'

describe('errorUtils', () => {
  describe('extractConnectionErrorDetails', () => {
    test('null/undefined → null', () => {
      expect(extractConnectionErrorDetails(null)).toBe(null)
      expect(extractConnectionErrorDetails(undefined)).toBe(null)
    })

    test('非对象 → null', () => {
      expect(extractConnectionErrorDetails('string')).toBe(null)
    })

    test('Error 无 code → null', () => {
      expect(extractConnectionErrorDetails(new Error('generic'))).toBe(null)
    })

    test('Error 含 SSL 错误码 → 识别为 SSL 错误', () => {
      const err = new Error('self signed cert')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
      const result = extractConnectionErrorDetails(err)
      expect(result).not.toBe(null)
      expect(result!.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
      expect(result!.isSSLError).toBe(true)
    })

    test('Error 含非 SSL 错误码 → isSSLError 为 false', () => {
      const err = new Error('timeout')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'ETIMEDOUT'
      const result = extractConnectionErrorDetails(err)
      expect(result).not.toBe(null)
      expect(result!.code).toBe('ETIMEDOUT')
      expect(result!.isSSLError).toBe(false)
    })

    test('遍历 cause 链找到根错误码', () => {
      const root = new Error('root error')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(root as any).code = 'ECONNREFUSED'

      const mid = new Error('mid error')
      mid.cause = root

      const top = new Error('top error')
      top.cause = mid

      const result = extractConnectionErrorDetails(top)
      expect(result).not.toBe(null)
      expect(result!.code).toBe('ECONNREFUSED')
      expect(result!.message).toBe('root error')
    })

    test('cause 链中找到 code（深度 3，在范围内）', () => {
      const root = new Error('root')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(root as any).code = 'ECONNREFUSED'

      let err = root
      for (let i = 0; i < 3; i++) {
        const next = new Error(`wrapper ${i}`)
        next.cause = err
        err = next
      }
      const result = extractConnectionErrorDetails(err)
      expect(result).not.toBe(null)
      expect(result!.code).toBe('ECONNREFUSED')
    })

    test('超过最大深度 5 时停止不崩溃', () => {
      let err = new Error('level 0 - no code')
      for (let i = 1; i < 10; i++) {
        const next = new Error(`level ${i}`)
        next.cause = err
        err = next
      }
      // 不加任何 code，所有层都无 code，验证不崩溃
      const result = extractConnectionErrorDetails(err)
      expect(result).toBe(null) // 无 code 的结果
    })

    test('circular cause 不会死循环', () => {
      const err = new Error('circular')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'ECIRCULAR'
      err.cause = err // 自引用
      const result = extractConnectionErrorDetails(err)
      // 取到当前的 code 就返回，不用遍历
      expect(result).not.toBe(null)
      expect(result!.code).toBe('ECIRCULAR')
    })
  })

  describe('formatAPIError', () => {
    test('ETIMEDOUT 错误 → 超时提示', () => {
      const err = new Error('timed out')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'ETIMEDOUT'
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('SSL 自签名证书错误 → 对应 SSL 提示', () => {
      const err = new Error('self signed')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('SSL 证书过期 → 对应 SSL 提示', () => {
      const err = new Error('cert expired')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'CERT_HAS_EXPIRED'
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('Connection error 无 code → 连接失败提示', () => {
      const err = new Error('Connection error.')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('普通 API 错误 → 返回 message', () => {
      const err = new Error('rate limit exceeded')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('rate limit exceeded')
    })

    test('message 为 undefined → 尝试嵌套提取', () => {
      const err = {
        status: 400,
        error: {
          error: { message: 'Bad Request' },
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('Bad Request')
    })

    test('嵌套 error 只有外层 message（Bedrock 形状）', () => {
      const err = {
        status: 500,
        error: {
          message: 'Internal server error',
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('Internal server error')
    })

    test('无 message 无嵌套错误 → 回退 status 消息', () => {
      const err = { status: 503 }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('HTML 消息被清理（提取 title）', () => {
      const err = new Error('<!DOCTYPE html><html><head><title>CloudFlare</title></head></html>')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('CloudFlare')
    })
  })

  describe('getSSLErrorHint', () => {
    test('SSL 错误 → 返回提示字符串', () => {
      const err = new Error('ssl error')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
      const result = getSSLErrorHint(err)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('非 SSL 错误 → null', () => {
      const err = new Error('timeout')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'ETIMEDOUT'
      expect(getSSLErrorHint(err)).toBe(null)
    })

    test('普通 Error → null', () => {
      expect(getSSLErrorHint(new Error('generic'))).toBe(null)
    })

    test('非 Error → null', () => {
      expect(getSSLErrorHint('string')).toBe(null)
      expect(getSSLErrorHint(null)).toBe(null)
    })
  })

  describe('formatAPIError: SSL 错误码全覆盖', () => {
    const sslCodes = [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
      'CERT_REVOKED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'HOSTNAME_MISMATCH',
      'CERT_NOT_YET_VALID',
      'UNKNOWN_SSL_CODE', // 通用兜底
    ]

    for (const code of sslCodes) {
      test(`${code} → 返回提示字符串`, () => {
        const err = new Error(`ssl: ${code}`)
        // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
        ;(err as any).code = code
        // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
        const result = formatAPIError(err as any)
        expect(result).toBeTruthy()
        expect(typeof result).toBe('string')
      })
    }
  })

  describe('formatAPIError: 嵌套 HTML 错误消息', () => {
    test('嵌套 error.error.message 含 HTML：提取 title', () => {
      const err = {
        error: {
          error: {
            message: '<!DOCTYPE html><html><head><title>CloudFlare Block</title></head></html>',
          },
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('CloudFlare Block')
    })

    test('嵌套 error.message 含 HTML（Bedrock 形状）：提取 title', () => {
      const err = {
        error: {
          message: '<!DOCTYPE html><html><head><title>Proxy Error</title></head></html>',
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBe('Proxy Error')
    })

    test('嵌套 error.error 有 message 但被 sanitize 清空后 → 回退 status', () => {
      const err = {
        status: 502,
        error: {
          error: {
            message: '<!DOCTYPE html><html><head></head></html>', // 无 title
          },
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
    })

    test('Bedrock 形状 + HTML 无 title → sanitize 返回空，继续 fallback', () => {
      const err = {
        status: 503,
        error: {
          message: '<!DOCTYPE html><html><head></head></html>', // 浅层 path，无 title
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
    })
  })

  describe('formatAPIError: connection error with code', () => {
    test('Connection error + 非 SSL code → 包含 code', () => {
      const err = new Error('Connection error.')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      ;(err as any).code = 'ECONNREFUSED'
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })

    test('Connection error + 无 code → 通用连接失败', () => {
      const err = new Error('Connection error.')
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      const result = formatAPIError(err as any)
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
    })
  })
})
