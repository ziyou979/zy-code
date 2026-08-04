import { describe, expect, test } from 'bun:test'
import {
  initWinWorkingSetTrim,
  trimWorkingSetNow,
} from '../../src/services/diagnostics/winWorkingSetTrim.js'

// Windows 专属服务。非 win32 平台只需验证 no-op 语义。
const isWin = process.platform === 'win32'

describe('winWorkingSetTrim', () => {
  test('trimWorkingSetNow 返回布尔且不抛异常', () => {
    expect(typeof trimWorkingSetNow()).toBe('boolean')
  })

  test('冷却期内重复调用被抑制', () => {
    const now = Date.now()
    // 冷却 0 必然尝试执行（无论成败都会设置 lastTrimAt）
    trimWorkingSetNow(now, 0)
    // 同一时间点 + 10 分钟冷却 → 距离上次 trim 不足冷却期，返回 false
    expect(trimWorkingSetNow(now, 10 * 60_000)).toBe(false)
  })

  test('initWinWorkingSetTrim 不抛异常', () => {
    expect(() => initWinWorkingSetTrim()).not.toThrow()
  })

  // Windows 上做一次真实的分配→trim 冒烟测试：trim 后进程仍可正常运行
  test('Windows 上 trim 后进程仍可正常运行', async () => {
    if (!isWin) {
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < 50; i++) {
      chunks.push('x'.repeat(1024 * 1024))
    }
    chunks.length = 0
    // 用未来时间戳 + 冷却 0 强制真实执行一次 trim
    const trimmed = trimWorkingSetNow(Date.now() + 60_000, 0)
    expect(typeof trimmed).toBe('boolean')
    await Bun.sleep(50)
    expect(1 + 1).toBe(2)
  }, 10_000)
})
