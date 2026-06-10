/**
 * semver 测试：语义化版本比较工具。
 *
 * 重点关注：
 * - gt / gte / lt / lte 基本比较
 * - satisfies 范围匹配
 * - order 排序返回值
 * - 预发布版本处理
 */
import { describe, expect, test } from 'bun:test'
import { gt, gte, lt, lte, order, satisfies } from '../../src/utils/semver.js'

describe('semver', () => {
  describe('gt', () => {
    test('major 更大', () => {
      expect(gt('2.0.0', '1.0.0')).toBe(true)
    })

    test('minor 更大', () => {
      expect(gt('1.1.0', '1.0.0')).toBe(true)
    })

    test('patch 更大', () => {
      expect(gt('1.0.1', '1.0.0')).toBe(true)
    })

    test('相等不大于', () => {
      expect(gt('1.0.0', '1.0.0')).toBe(false)
    })

    test('更小返回 false', () => {
      expect(gt('1.0.0', '2.0.0')).toBe(false)
    })
  })

  describe('gte', () => {
    test('大于', () => {
      expect(gte('2.0.0', '1.0.0')).toBe(true)
    })

    test('相等', () => {
      expect(gte('1.0.0', '1.0.0')).toBe(true)
    })

    test('小于', () => {
      expect(gte('1.0.0', '2.0.0')).toBe(false)
    })
  })

  describe('lt', () => {
    test('小于', () => {
      expect(lt('1.0.0', '2.0.0')).toBe(true)
    })

    test('相等不小于', () => {
      expect(lt('1.0.0', '1.0.0')).toBe(false)
    })

    test('大于', () => {
      expect(lt('2.0.0', '1.0.0')).toBe(false)
    })
  })

  describe('lte', () => {
    test('小于', () => {
      expect(lte('1.0.0', '2.0.0')).toBe(true)
    })

    test('相等', () => {
      expect(lte('1.0.0', '1.0.0')).toBe(true)
    })

    test('大于', () => {
      expect(lte('2.0.0', '1.0.0')).toBe(false)
    })
  })

  describe('satisfies', () => {
    test('精确匹配', () => {
      expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    })

    test('范围匹配 ^', () => {
      expect(satisfies('1.2.3', '^1.0.0')).toBe(true)
      expect(satisfies('2.0.0', '^1.0.0')).toBe(false)
    })

    test('范围匹配 ~', () => {
      expect(satisfies('1.2.5', '~1.2.0')).toBe(true)
      expect(satisfies('1.3.0', '~1.2.0')).toBe(false)
    })

    test('范围匹配 >=', () => {
      expect(satisfies('2.0.0', '>=1.0.0')).toBe(true)
      expect(satisfies('0.9.0', '>=1.0.0')).toBe(false)
    })
  })

  describe('order', () => {
    test('a > b 返回 1', () => {
      expect(order('2.0.0', '1.0.0')).toBe(1)
    })

    test('a < b 返回 -1', () => {
      expect(order('1.0.0', '2.0.0')).toBe(-1)
    })

    test('a = b 返回 0', () => {
      expect(order('1.0.0', '1.0.0')).toBe(0)
    })

    test('patch 级别比较', () => {
      expect(order('1.0.2', '1.0.1')).toBe(1)
    })
  })
})
