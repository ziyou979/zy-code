/**
 * teammate mailbox 畸形消息过滤（对齐 CC 2.1.207 crash loop）
 */
import { describe, expect, test } from 'bun:test'
import { isValidTeammateMessage } from '../../src/utils/teammateMailbox.js'

describe('isValidTeammateMessage', () => {
  test('接受完整消息', () => {
    expect(
      isValidTeammateMessage({
        from: 'lead',
        text: 'hello',
        timestamp: new Date().toISOString(),
        read: false,
      }),
    ).toBe(true)
  })

  test('拒绝缺失字段 / 类型错误', () => {
    expect(isValidTeammateMessage(null)).toBe(false)
    expect(isValidTeammateMessage({})).toBe(false)
    expect(isValidTeammateMessage({ from: 'a', text: 1, timestamp: 't', read: false })).toBe(false)
    expect(isValidTeammateMessage({ from: 'a', text: 'x', timestamp: 't', read: 'yes' })).toBe(
      false,
    )
  })
})
