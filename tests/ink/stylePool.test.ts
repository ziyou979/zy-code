/**
 * StylePool 测试：验证 intern / poolSize / clearCaches / collectLiveStyleIds。
 */
import { describe, expect, test } from 'bun:test'
import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  collectLiveStyleIds,
  createScreen,
  setCellAt,
} from '../../src/ink/screen.js'

const RED: AnsiCode = { type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }
const GREEN: AnsiCode = { type: 'ansi', code: '\x1b[32m', endCode: '\x1b[39m' }
const BLUE: AnsiCode = { type: 'ansi', code: '\x1b[34m', endCode: '\x1b[39m' }
const BG_YELLOW: AnsiCode = { type: 'ansi', code: '\x1b[43m', endCode: '\x1b[49m' }

describe('StylePool', () => {
  describe('poolSize', () => {
    test('新建 pool 包含 none（1 个条目）', () => {
      const pool = new StylePool()
      expect(pool.poolSize()).toBe(1)
    })

    test('intern 新样式增加 poolSize', () => {
      const pool = new StylePool()
      pool.intern([RED])
      pool.intern([GREEN])
      expect(pool.poolSize()).toBe(3)
    })

    test('intern 相同样式不增加 poolSize', () => {
      const pool = new StylePool()
      const id1 = pool.intern([RED])
      const id2 = pool.intern([RED])
      expect(id1).toBe(id2)
      expect(pool.poolSize()).toBe(2)
    })
  })

  describe('intern 编码 ID', () => {
    test('仅前景色的样式获得偶数 ID（visBit=0）', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      expect(redId & 1).toBe(0)
    })

    test('带背景色的样式获得奇数 ID（visBit=1）', () => {
      const pool = new StylePool()
      const bgId = pool.intern([BG_YELLOW])
      expect(bgId & 1).toBe(1)
    })

    test('none 的编码 ID 始终为 0', () => {
      const pool = new StylePool()
      expect(pool.none).toBe(0)
      expect(pool.get(pool.none)).toEqual([])
    })
  })

  describe('transition', () => {
    test('相同 ID 的 transition 为空字符串', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      expect(pool.transition(redId, redId)).toBe('')
    })

    test('不同 ID 的 transition 包含 ANSI 序列', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])
      const trans = pool.transition(redId, greenId)
      expect(trans.length).toBeGreaterThan(0)
      expect(trans).toContain('\x1b[32m')
    })

    test('transition 结果被缓存', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])
      const trans1 = pool.transition(redId, greenId)
      const trans2 = pool.transition(redId, greenId)
      expect(trans1).toBe(trans2) // 同一引用
    })
  })

  describe('clearCaches', () => {
    test('clearCaches 后 transition 仍然正确（按需重算）', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])
      const before = pool.transition(redId, greenId)

      pool.clearCaches()

      const after = pool.transition(redId, greenId)
      expect(after).toBe(before) // 值相等（重新计算）
    })

    test('clearCaches 不改变 poolSize', () => {
      const pool = new StylePool()
      pool.intern([RED])
      pool.intern([GREEN])
      pool.intern([BLUE])
      const sizeBefore = pool.poolSize()

      pool.clearCaches()

      expect(pool.poolSize()).toBe(sizeBefore)
    })

    test('clearCaches 不改变已有的 style ID', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])

      pool.clearCaches()

      // 用同样的样式再 intern，应返回相同的 ID
      expect(pool.intern([RED])).toBe(redId)
      expect(pool.intern([GREEN])).toBe(greenId)
    })

    test('clearCaches 后 withInverse 按需重算', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const invBefore = pool.withInverse(redId)

      pool.clearCaches()

      const invAfter = pool.withInverse(redId)
      expect(invAfter).toBe(invBefore) // 相同的编码 ID
    })
  })
})

describe('collectLiveStyleIds', () => {
  test('收集屏幕中所有活跃样式 ID', () => {
    const stylePool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const screen = createScreen(3, 2, stylePool, charPool, hyperlinkPool)

    const redId = stylePool.intern([RED])
    const greenId = stylePool.intern([GREEN])

    setCellAt(screen, 0, 0, { char: 'a', styleId: redId, width: 0, hyperlink: undefined })
    setCellAt(screen, 1, 0, { char: 'b', styleId: greenId, width: 0, hyperlink: undefined })
    setCellAt(screen, 2, 0, { char: 'c', styleId: redId, width: 0, hyperlink: undefined })

    const live = collectLiveStyleIds(screen)
    expect(live.has(0)).toBe(true) // none
    expect(live.has(redId)).toBe(true)
    expect(live.has(greenId)).toBe(true)
    expect(live.size).toBe(3) // none + red + green（空单元格都是 none）
  })
})
