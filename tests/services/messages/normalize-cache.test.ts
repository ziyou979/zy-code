import { describe, expect, test } from 'bun:test'
import {
  createMessageNormalizer,
  normalizeMessages,
} from '../../../src/services/messages/normalize.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../../src/services/messages/constructors.js'

describe('createMessageNormalizer', () => {
  test('追加消息保持历史行引用，替换消息只更新对应行', () => {
    const normalize = createMessageNormalizer()
    const a = createAssistantMessage({ content: 'first' })
    const b = createUserMessage({ content: [{ type: 'text', text: 'second' }] })
    const first = normalize([a])
    const next = normalize([a, b])
    expect(next[0]).toBe(first[0])
    const changed = {
      ...a,
      message: { ...a.message, content: [{ type: 'text' as const, text: 'changed' }] },
    }
    const updated = normalize([changed, b])
    expect(updated[0]).not.toBe(first[0])
    expect(updated[1]).toBe(next[1])
    expect(updated).toEqual(normalizeMessages([changed, b]))
  })
  test('插入和移除多块前缀后 UUID 与无缓存实现一致', () => {
    const normalize = createMessageNormalizer()
    const a = createAssistantMessage({ content: 'single' })
    const multi = createAssistantMessage({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    })
    const original = normalize([a])
    expect(normalize([multi, a])).toEqual(normalizeMessages([multi, a]))
    expect(normalize([a])[0]).toBe(original[0])
    expect(normalize([a, multi])).toEqual(normalizeMessages([a, multi]))
    expect(normalize([])).toEqual([])
  })
})
