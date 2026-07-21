/**
 * thinking 测试：thinking 相关纯函数。
 *
 * 重点关注：
 * - hasUltrathinkKeyword 关键词检测（大小写、单词边界）
 * - findThinkingTriggerPositions 位置查找（多次出现、无匹配）
 * - getRainbowColor 颜色索引循环
 */
import { describe, expect, test } from 'bun:test'
import {
  findThinkingTriggerPositions,
  getRainbowColor,
  hasUltrathinkKeyword,
} from '../../src/services/messages/thinking.js'

describe('thinking', () => {
  describe('hasUltrathinkKeyword', () => {
    test('包含 ultrathink 返回 true', () => {
      expect(hasUltrathinkKeyword('please ultrathink about this')).toBe(true)
    })

    test('大小写不敏感', () => {
      expect(hasUltrathinkKeyword('ULTRATHINK')).toBe(true)
      expect(hasUltrathinkKeyword('UltraThink')).toBe(true)
    })

    test('单词边界限制', () => {
      expect(hasUltrathinkKeyword('notultrathinkhere')).toBe(false)
      expect(hasUltrathinkKeyword('ultrathinking')).toBe(false)
    })

    test('无匹配返回 false', () => {
      expect(hasUltrathinkKeyword('hello world')).toBe(false)
      expect(hasUltrathinkKeyword('')).toBe(false)
    })

    test('在句子中间', () => {
      expect(hasUltrathinkKeyword('use ultrathink now')).toBe(true)
    })
  })

  describe('findThinkingTriggerPositions', () => {
    test('找到单个匹配', () => {
      const positions = findThinkingTriggerPositions('hello ultrathink world')
      expect(positions).toHaveLength(1)
      expect(positions[0]!.word).toBe('ultrathink')
      expect(positions[0]!.start).toBe(6)
      expect(positions[0]!.end).toBe(16)
    })

    test('找到多个匹配', () => {
      const positions = findThinkingTriggerPositions('ultrathink and ultrathink')
      expect(positions).toHaveLength(2)
      expect(positions[0]!.start).toBe(0)
      expect(positions[1]!.start).toBe(15)
    })

    test('无匹配返回空数组', () => {
      expect(findThinkingTriggerPositions('nothing here')).toEqual([])
      expect(findThinkingTriggerPositions('')).toEqual([])
    })

    test('大小写保留在 word 中', () => {
      const positions = findThinkingTriggerPositions('ULTRATHINK')
      expect(positions).toHaveLength(1)
      expect(positions[0]!.word).toBe('ULTRATHINK')
    })

    test('单词边界限制（不匹配子串）', () => {
      expect(findThinkingTriggerPositions('ultrathinking')).toEqual([])
    })
  })

  describe('getRainbowColor', () => {
    test('索引 0 返回第一个颜色', () => {
      expect(getRainbowColor(0)).toBe('rainbow_red')
    })

    test('索引循环（7色）', () => {
      expect(getRainbowColor(7)).toBe('rainbow_red')
      expect(getRainbowColor(14)).toBe('rainbow_red')
    })

    test('shimmer 模式返回 shimmer 颜色', () => {
      expect(getRainbowColor(0, true)).toBe('rainbow_red_shimmer')
    })

    test('连续颜色不同', () => {
      const colors = Array.from({ length: 7 }, (_, i) => getRainbowColor(i))
      const unique = new Set(colors)
      expect(unique.size).toBe(7)
    })
  })
})
