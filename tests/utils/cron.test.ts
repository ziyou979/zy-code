/**
 * cron 测试：cron 表达式解析与下次运行时间计算。
 *
 * 重点关注：
 * - parseCronExpression 各字段语法（通配符、步进、范围、列表）
 * - computeNextCronRun 时间推进、OR 语义（dom/dow 同时约束）
 * - cronToHuman 各模式的人类可读转换
 * - 无效表达式返回 null
 */
import { describe, expect, test } from 'bun:test'
import {
  type CronFields,
  computeNextCronRun,
  cronToHuman,
  parseCronExpression,
} from '../../src/utils/cron.js'

describe('cron', () => {
  describe('parseCronExpression', () => {
    test('全通配符 "* * * * *"', () => {
      const result = parseCronExpression('* * * * *')
      expect(result).not.toBeNull()
      expect(result!.minute).toHaveLength(60)
      expect(result!.hour).toHaveLength(24)
      expect(result!.dayOfMonth).toHaveLength(31)
      expect(result!.month).toHaveLength(12)
      expect(result!.dayOfWeek).toHaveLength(7)
    })

    test('固定值 "30 9 * * *"', () => {
      const result = parseCronExpression('30 9 * * *')
      expect(result).not.toBeNull()
      expect(result!.minute).toEqual([30])
      expect(result!.hour).toEqual([9])
    })

    test('步进 "*/5 * * * *"', () => {
      const result = parseCronExpression('*/5 * * * *')
      expect(result).not.toBeNull()
      expect(result!.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    })

    test('范围 "0 9-17 * * *"', () => {
      const result = parseCronExpression('0 9-17 * * *')
      expect(result).not.toBeNull()
      expect(result!.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    })

    test('范围+步进 "0 0-23/2 * * *"', () => {
      const result = parseCronExpression('0 0-23/2 * * *')
      expect(result).not.toBeNull()
      expect(result!.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22])
    })

    test('列表 "0 9,12,18 * * *"', () => {
      const result = parseCronExpression('0 9,12,18 * * *')
      expect(result).not.toBeNull()
      expect(result!.hour).toEqual([9, 12, 18])
    })

    test('星期日别名：7 → 0', () => {
      const result = parseCronExpression('0 0 * * 7')
      expect(result).not.toBeNull()
      expect(result!.dayOfWeek).toEqual([0])
    })

    test('星期范围含 7：5-7 → [0, 5, 6]', () => {
      const result = parseCronExpression('0 0 * * 5-7')
      expect(result).not.toBeNull()
      expect(result!.dayOfWeek).toEqual([0, 5, 6])
    })

    test('工作日 "* * * * 1-5"', () => {
      const result = parseCronExpression('* * * * 1-5')
      expect(result).not.toBeNull()
      expect(result!.dayOfWeek).toEqual([1, 2, 3, 4, 5])
    })

    test('字段数不足返回 null', () => {
      expect(parseCronExpression('* * *')).toBeNull()
    })

    test('字段数过多返回 null', () => {
      expect(parseCronExpression('* * * * * *')).toBeNull()
    })

    test('无效值返回 null', () => {
      expect(parseCronExpression('60 * * * *')).toBeNull()
      expect(parseCronExpression('* 24 * * *')).toBeNull()
      expect(parseCronExpression('* * 0 * *')).toBeNull()
      expect(parseCronExpression('* * * 13 *')).toBeNull()
      expect(parseCronExpression('* * * * 8')).toBeNull()
    })

    test('无效语法返回 null', () => {
      expect(parseCronExpression('abc * * * *')).toBeNull()
      expect(parseCronExpression('')).toBeNull()
    })

    test('前后空格正常解析', () => {
      const result = parseCronExpression('  30 9 * * *  ')
      expect(result).not.toBeNull()
      expect(result!.minute).toEqual([30])
    })
  })

  describe('computeNextCronRun', () => {
    test('每分钟：下一分钟触发', () => {
      const fields = parseCronExpression('* * * * *')!
      const from = new Date(2025, 0, 1, 10, 30, 0)
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getMinutes()).toBe(31)
      expect(next!.getHours()).toBe(10)
    })

    test('固定时间：跳到下次匹配', () => {
      const fields = parseCronExpression('0 9 * * *')!
      const from = new Date(2025, 0, 1, 10, 0, 0)
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getHours()).toBe(9)
      expect(next!.getMinutes()).toBe(0)
      expect(next!.getDate()).toBe(2)
    })

    test('当前时间恰好匹配也要跳到下一个', () => {
      const fields = parseCronExpression('30 10 * * *')!
      const from = new Date(2025, 0, 1, 10, 30, 0)
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getDate()).toBe(2)
    })

    test('dom/dow 同时约束时使用 OR 语义', () => {
      // 每月1号 OR 每周一
      const fields = parseCronExpression('0 0 1 * 1')!
      const from = new Date(2025, 0, 1, 1, 0, 0) // 2025-01-01 周三
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      // 下一个匹配：2025-01-06 周一 或 2025-02-01，取较早的
      // 2025-01-06 是周一，更早
      expect(next!.getDate()).toBe(6)
      expect(next!.getMonth()).toBe(0)
    })

    test('跨月查找', () => {
      // 每月31号
      const fields = parseCronExpression('0 0 31 * *')!
      const from = new Date(2025, 1, 1, 0, 0, 0) // 2月无31号
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getDate()).toBe(31)
      expect(next!.getMonth()).toBe(2) // 3月
    })

    test('步进每5分钟', () => {
      const fields = parseCronExpression('*/5 * * * *')!
      const from = new Date(2025, 0, 1, 10, 22, 0)
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getMinutes()).toBe(25)
    })

    test('返回的秒和毫秒为 0', () => {
      const fields = parseCronExpression('* * * * *')!
      const from = new Date(2025, 0, 1, 10, 30, 45, 500)
      const next = computeNextCronRun(fields, from)
      expect(next).not.toBeNull()
      expect(next!.getSeconds()).toBe(0)
      expect(next!.getMilliseconds()).toBe(0)
    })
  })

  describe('cronToHuman', () => {
    test('*/1 = 每分钟', () => {
      expect(cronToHuman('*/1 * * * *')).toBe('Every minute')
    })

    test('"* * * * *" 无法识别为固定模式，原样返回', () => {
      expect(cronToHuman('* * * * *')).toBe('* * * * *')
    })

    test('每 N 分钟', () => {
      expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes')
    })

    test('每1分钟', () => {
      expect(cronToHuman('*/1 * * * *')).toBe('Every minute')
    })

    test('每小时整点', () => {
      expect(cronToHuman('0 * * * *')).toBe('Every hour')
    })

    test('每小时指定分钟', () => {
      expect(cronToHuman('15 * * * *')).toBe('Every hour at :15')
    })

    test('每 N 小时', () => {
      expect(cronToHuman('0 */2 * * *')).toBe('Every 2 hours')
    })

    test('每 N 小时带分钟偏移', () => {
      expect(cronToHuman('30 */3 * * *')).toBe('Every 3 hours at :30')
    })

    test('每天固定时间', () => {
      const result = cronToHuman('0 9 * * *')
      expect(result).toMatch(/Every day at/)
      expect(result).toMatch(/9:00/)
    })

    test('工作日', () => {
      const result = cronToHuman('0 9 * * 1-5')
      expect(result).toMatch(/Weekdays at/)
    })

    test('无法识别的复杂表达式原样返回', () => {
      expect(cronToHuman('*/5 9-17 * * 1-5')).toBe('*/5 9-17 * * 1-5')
    })

    test('字段数不对原样返回', () => {
      expect(cronToHuman('bad')).toBe('bad')
    })
  })
})
