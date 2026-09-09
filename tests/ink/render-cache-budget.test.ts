import { describe, expect, test } from 'bun:test'
import Output from '../../src/ink/output.js'
import { lineWidth } from '../../src/ink/lineWidthCache.js'
import {
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  StylePool,
} from '../../src/ink/screen.js'

describe('渲染缓存容量', () => {
  test('持续写入长行时字素缓存按容量淘汰，淘汰后重绘仍正确', () => {
    const styles = new StylePool()
    const screen = createScreen(20, 1, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 20, height: 1, stylePool: styles, screen })
    const first = '旧'.repeat(2048)
    for (let i = 0; i < 160; i++) {
      output.reset(20, 1, screen)
      output.write(0, 0, i === 0 ? first : `${i}${'x'.repeat(2048)}`)
      output.get()
    }
    // 白盒检查容量契约，避免依赖 GC 时机或进程 RSS 的不稳定阈值。
    expect(output['charCache'].calculatedSize).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(output['charCache'].has(first)).toBe(false)
    output.reset(20, 1, screen)
    output.write(0, 0, first)
    output.get()
    expect(charInCellAt(screen, 0, 0)).toBe('旧')
  })

  test('超大条目正常显示但不驻留字素缓存', () => {
    const styles = new StylePool()
    const screen = createScreen(20, 1, styles, new CharPool(), new HyperlinkPool())
    const output = new Output({ width: 20, height: 1, stylePool: styles, screen })
    const large = '大'.repeat(10000)
    output.write(0, 0, large)
    output.get()
    expect(output['charCache'].has(large)).toBe(false)
    expect(charInCellAt(screen, 0, 0)).toBe('大')
  })

  test('宽度缓存淘汰或跳过长行不改变 Unicode 和 ANSI 测量', () => {
    const text = '\x1b[31m中文🙂\x1b[0m'
    expect(lineWidth(text)).toBe(6)
    for (let i = 0; i < 4200; i++) lineWidth(`${i}${'x'.repeat(180)}`)
    expect(lineWidth(text)).toBe(6)
    expect(lineWidth('中'.repeat(10000))).toBe(20000)
    expect(lineWidth('')).toBe(0)
  })
})
