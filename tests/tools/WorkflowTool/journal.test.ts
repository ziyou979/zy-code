import { describe, expect, test } from 'bun:test'
import { computeAgentKey } from '../../../src/tools/WorkflowTool/runtime/journal.js'

describe('WorkflowJournal', () => {
  describe('computeAgentKey', () => {
    test('相同输入产生相同 key', () => {
      const key1 = computeAgentKey('hello', { model: 'opus' }, '')
      const key2 = computeAgentKey('hello', { model: 'opus' }, '')
      expect(key1).toBe(key2)
    })

    test('不同 prompt 产生不同 key', () => {
      const key1 = computeAgentKey('hello', undefined, '')
      const key2 = computeAgentKey('world', undefined, '')
      expect(key1).not.toBe(key2)
    })

    test('不同 prevKey 产生不同 key（链式盐）', () => {
      const key1 = computeAgentKey('hello', undefined, 'salt_a')
      const key2 = computeAgentKey('hello', undefined, 'salt_b')
      expect(key1).not.toBe(key2)
    })

    test('白名单外的 opts 字段不影响 key', () => {
      const key1 = computeAgentKey('hello', { label: 'a', phase: 'p1' }, '')
      const key2 = computeAgentKey('hello', { label: 'b', phase: 'p2' }, '')
      expect(key1).toBe(key2)
    })

    test('白名单内字段变化会改变 key', () => {
      const key1 = computeAgentKey('hello', { model: 'opus' }, '')
      const key2 = computeAgentKey('hello', { model: 'sonnet' }, '')
      expect(key1).not.toBe(key2)
    })

    test('schema 变化会改变 key', () => {
      const key1 = computeAgentKey('hello', { schema: { type: 'object' } }, '')
      const key2 = computeAgentKey('hello', { schema: { type: 'array' } }, '')
      expect(key1).not.toBe(key2)
    })

    test('key 以 v2: 前缀开头', () => {
      const key = computeAgentKey('prompt', undefined, '')
      expect(key.startsWith('v2:')).toBe(true)
    })

    test('opts 字段顺序不影响 key（稳定序列化）', () => {
      const key1 = computeAgentKey('p', { model: 'x', agentType: 'y' }, '')
      const key2 = computeAgentKey('p', { agentType: 'y', model: 'x' }, '')
      expect(key1).toBe(key2)
    })
  })
})
