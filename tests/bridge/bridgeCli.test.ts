import { describe, expect, test } from 'bun:test'
import {
  parseArgs,
  parseCapacityValue,
  parseSessionTimeoutValue,
} from '../../src/bridge/bridge-main/cli.js'

describe('bridge CLI 参数校验', () => {
  test('capacity 只接受严格正整数', () => {
    expect(parseCapacityValue('1')).toBe(1)
    expect(parseCapacityValue('1foo')).toContain('requires a positive integer')
    expect(parseCapacityValue('0')).toContain('requires a positive integer')
  })

  test('session timeout 只接受严格正整数秒数', () => {
    expect(parseSessionTimeoutValue('2')).toBe(2000)
    expect(parseSessionTimeoutValue(undefined)).toContain('requires a positive integer')
    expect(parseSessionTimeoutValue('NaN')).toContain('requires a positive integer')
    expect(parseSessionTimeoutValue('0')).toContain('requires a positive integer')
  })

  test('parseArgs 报告缺失和无效的 session timeout', () => {
    expect(parseArgs(['--session-timeout']).error).toContain('requires a positive integer')
    expect(parseArgs(['--session-timeout=1foo']).error).toContain('requires a positive integer')
    expect(parseArgs(['--session-timeout=-1']).error).toContain('requires a positive integer')
  })
})
