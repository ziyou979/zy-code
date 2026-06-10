/**
 * StylePool 压缩测试：验证 compact/needsCompaction/collectLiveStyleIds/remapScreenStyleIds。
 */
import { describe, expect, test } from 'bun:test'
import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  collectLiveStyleIds,
  createScreen,
  remapScreenStyleIds,
  setCellAt,
} from '../../src/ink/screen.js'

const RED: AnsiCode = { type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }
const GREEN: AnsiCode = { type: 'ansi', code: '\x1b[32m', endCode: '\x1b[39m' }
const BLUE: AnsiCode = { type: 'ansi', code: '\x1b[34m', endCode: '\x1b[39m' }
const BOLD: AnsiCode = { type: 'ansi', code: '\x1b[1m', endCode: '\x1b[22m' }
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

  describe('needsCompaction', () => {
    test('lastLiveSize=0 时返回 false', () => {
      const pool = new StylePool()
      pool.lastLiveSize = 0
      expect(pool.needsCompaction()).toBe(false)
    })

    test('总量 <= 活跃量*3 时返回 false', () => {
      const pool = new StylePool()
      pool.intern([RED])
      pool.intern([GREEN])
      pool.intern([BLUE])
      pool.lastLiveSize = 2
      // poolSize=4, lastLiveSize=2, 4 <= 6 → false
      expect(pool.needsCompaction()).toBe(false)
    })

    test('总量 > 活跃量*3 时返回 true', () => {
      const pool = new StylePool()
      for (let i = 0; i < 10; i++) {
        pool.intern([{ type: 'ansi', code: `\x1b[${30 + i}m`, endCode: '\x1b[39m' }])
      }
      pool.lastLiveSize = 2
      // poolSize=11, lastLiveSize=2, 11 > 6 → true
      expect(pool.needsCompaction()).toBe(true)
    })
  })

  describe('compact', () => {
    test('只保留 liveIds 中的样式', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])
      pool.intern([BLUE])
      pool.intern([BOLD])

      const liveIds = new Set([redId, greenId])
      const remap = pool.compact(liveIds)

      expect(remap).not.toBeNull()
      // none + red + green = 3
      expect(pool.poolSize()).toBe(3)
    })

    test('none 始终保留在 ID 0', () => {
      const pool = new StylePool()
      pool.intern([RED])
      pool.intern([GREEN])
      const liveIds = new Set([pool.intern([RED])])
      pool.compact(liveIds)
      expect(pool.none).toBe(0)
      expect(pool.get(pool.none)).toEqual([])
    })

    test('compact 后 transition 仍然正确', () => {
      const pool = new StylePool()
      const redId = pool.intern([RED])
      const greenId = pool.intern([GREEN])
      pool.intern([BLUE])
      pool.intern([BOLD])

      const liveIds = new Set([redId, greenId])
      const remap = pool.compact(liveIds)!

      const newRedId = remap.get(redId)!
      const newGreenId = remap.get(greenId)!

      // transition 应该生成有效的 ANSI 序列
      const trans = pool.transition(newRedId, newGreenId)
      expect(trans.length).toBeGreaterThan(0)
      expect(trans).toContain('\x1b[32m')
    })

    test('所有样式都活跃时返回 null', () => {
      const pool = new StylePool()
      const id1 = pool.intern([RED])
      const id2 = pool.intern([GREEN])
      const liveIds = new Set([pool.none, id1, id2])
      const remap = pool.compact(liveIds)
      expect(remap).toBeNull()
    })

    test('compact 更新 lastLiveSize', () => {
      const pool = new StylePool()
      pool.intern([RED])
      pool.intern([GREEN])
      pool.intern([BLUE])
      pool.intern([BOLD])
      pool.intern([BG_YELLOW])

      const liveIds = new Set([pool.intern([RED])])
      pool.compact(liveIds)
      expect(pool.lastLiveSize).toBe(2) // none + red
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
    // none (空单元格) + red + green
    expect(live.has(0)).toBe(true) // emptyStyleId (none=0)
    expect(live.has(redId)).toBe(true)
    expect(live.has(greenId)).toBe(true)
  })
})

describe('remapScreenStyleIds', () => {
  test('用映射表替换屏幕中所有 styleId', () => {
    const stylePool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const screen = createScreen(2, 1, stylePool, charPool, hyperlinkPool)

    const oldRedId = stylePool.intern([RED])
    setCellAt(screen, 0, 0, { char: 'x', styleId: oldRedId, width: 0, hyperlink: undefined })

    const remap = new Map([[oldRedId, 42]])
    remapScreenStyleIds(screen, remap)

    const live = collectLiveStyleIds(screen)
    expect(live.has(42)).toBe(true)
    expect(live.has(oldRedId)).toBe(false)
  })
})
