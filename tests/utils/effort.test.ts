/**
 * effort 测试：effort 档位体系的纯函数部分。
 *
 * 重点关注：
 * - isEffortLevel 类型守卫
 * - parseEffortValue 含旧值兼容
 * - migrateLegacyEffort 旧→新映射
 * - clampEffort 向下/向上搜索逻辑
 * - toPersistableEffort 过滤 orchestrate
 * - convertEffortValueToLevel / isOrchestrateEffort
 * - resolvePickerEffortPersistence 持久化决策
 * - getEffortLevelDescription 每个档位都有描述
 */
import { describe, expect, test } from 'bun:test'
import {
  clampEffort,
  convertEffortValueToLevel,
  EFFORT_LEVELS,
  type EffortLevel,
  getEffortLevelDescription,
  isEffortLevel,
  isOrchestrateEffort,
  migrateLegacyEffort,
  type PersistableEffortLevel,
  parseEffortValue,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../../src/utils/effort.js'

describe('effort', () => {
  describe('isEffortLevel', () => {
    test('所有有效档位返回 true', () => {
      for (const level of EFFORT_LEVELS) {
        expect(isEffortLevel(level)).toBe(true)
      }
    })

    test('无效值返回 false', () => {
      expect(isEffortLevel('invalid')).toBe(false)
      expect(isEffortLevel('')).toBe(false)
      expect(isEffortLevel('medium')).toBe(false) // 旧值
    })
  })

  describe('parseEffortValue', () => {
    test('有效值直接返回', () => {
      expect(parseEffortValue('balanced')).toBe('balanced')
      expect(parseEffortValue('quick')).toBe('quick')
      expect(parseEffortValue('orchestrate')).toBe('orchestrate')
    })

    test('大小写不敏感', () => {
      expect(parseEffortValue('BALANCED')).toBe('balanced')
      expect(parseEffortValue('Quick')).toBe('quick')
    })

    test('旧值自动迁移', () => {
      expect(parseEffortValue('medium')).toBe('balanced')
      expect(parseEffortValue('high')).toBe('thorough')
      expect(parseEffortValue('max')).toBe('extreme')
      expect(parseEffortValue('low')).toBe('light')
      expect(parseEffortValue('minimal')).toBe('quick')
    })

    test('null/undefined/空字符串返回 undefined', () => {
      expect(parseEffortValue(null)).toBeUndefined()
      expect(parseEffortValue(undefined)).toBeUndefined()
      expect(parseEffortValue('')).toBeUndefined()
    })

    test('完全无效值返回 undefined', () => {
      expect(parseEffortValue('garbage')).toBeUndefined()
    })
  })

  describe('migrateLegacyEffort', () => {
    test('已经是新格式直接返回', () => {
      expect(migrateLegacyEffort('balanced')).toBe('balanced')
    })

    test('旧格式映射', () => {
      expect(migrateLegacyEffort('minimal')).toBe('quick')
      expect(migrateLegacyEffort('low')).toBe('light')
      expect(migrateLegacyEffort('medium')).toBe('balanced')
      expect(migrateLegacyEffort('high')).toBe('thorough')
      expect(migrateLegacyEffort('xhigh')).toBe('extreme')
      expect(migrateLegacyEffort('max')).toBe('extreme')
      expect(migrateLegacyEffort('ultracode')).toBe('orchestrate')
    })

    test('未知值返回 undefined', () => {
      expect(migrateLegacyEffort('unknown')).toBeUndefined()
    })
  })

  describe('clampEffort', () => {
    const allLevels: EffortLevel[] = ['off', 'quick', 'light', 'balanced', 'thorough', 'extreme']

    test('请求的档位在支持列表中直接返回', () => {
      expect(clampEffort('balanced', allLevels)).toBe('balanced')
    })

    test('支持列表为空返回 undefined', () => {
      expect(clampEffort('balanced', [])).toBeUndefined()
    })

    test('请求的档位不在支持列表中向下搜索', () => {
      expect(clampEffort('extreme', ['quick', 'balanced'])).toBe('balanced')
    })

    test('向下搜索无结果则向上搜索', () => {
      expect(clampEffort('off', ['balanced', 'thorough'])).toBe('balanced')
    })

    test('只有一个支持档位', () => {
      expect(clampEffort('extreme', ['balanced'])).toBe('balanced')
    })
  })

  describe('toPersistableEffort', () => {
    test('可持久化档位原样返回', () => {
      const persistable: PersistableEffortLevel[] = [
        'off',
        'quick',
        'light',
        'balanced',
        'thorough',
        'extreme',
      ]
      for (const level of persistable) {
        expect(toPersistableEffort(level)).toBe(level)
      }
    })

    test('orchestrate 不可持久化', () => {
      expect(toPersistableEffort('orchestrate')).toBeUndefined()
    })

    test('undefined 返回 undefined', () => {
      expect(toPersistableEffort(undefined)).toBeUndefined()
    })
  })

  describe('convertEffortValueToLevel', () => {
    test('有效 EffortLevel 原样返回', () => {
      expect(convertEffortValueToLevel('balanced')).toBe('balanced')
      expect(convertEffortValueToLevel('extreme')).toBe('extreme')
    })

    test('orchestrate 也是有效 level', () => {
      expect(convertEffortValueToLevel('orchestrate')).toBe('orchestrate')
    })
  })

  describe('isOrchestrateEffort', () => {
    test('orchestrate → true', () => {
      expect(isOrchestrateEffort('orchestrate')).toBe(true)
    })

    test('其他值 → false', () => {
      expect(isOrchestrateEffort('extreme')).toBe(false)
      expect(isOrchestrateEffort(undefined)).toBe(false)
    })
  })

  describe('resolvePickerEffortPersistence', () => {
    test('与模型默认相同且无显式切换 → undefined（不持久化）', () => {
      expect(
        resolvePickerEffortPersistence('balanced', 'balanced', undefined, false),
      ).toBeUndefined()
    })

    test('与模型默认不同 → 持久化', () => {
      expect(resolvePickerEffortPersistence('thorough', 'balanced', undefined, false)).toBe(
        'thorough',
      )
    })

    test('有先前持久化值 → 持久化', () => {
      expect(resolvePickerEffortPersistence('balanced', 'balanced', 'thorough', false)).toBe(
        'balanced',
      )
    })

    test('picker 中发生过切换 → 持久化', () => {
      expect(resolvePickerEffortPersistence('balanced', 'balanced', undefined, true)).toBe(
        'balanced',
      )
    })
  })

  describe('getEffortLevelDescription', () => {
    test('每个档位都有非空描述', () => {
      for (const level of EFFORT_LEVELS) {
        const desc = getEffortLevelDescription(level)
        expect(typeof desc).toBe('string')
        expect(desc.length).toBeGreaterThan(0)
      }
    })
  })
})
