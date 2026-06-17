/**
 * 验证 Output.get() 中 switch 语句的 blit/shift case 不会 fall-through 到 write case。
 * 回归测试：修复前缺少 continue，导致 blit/shift 后滑入 write，
 * 因 undefined.split('\n') 崩溃，screen buffer 不完整，渲染重叠。
 */
import { describe, expect, test } from 'bun:test'
import Output from '../../src/ink/output.js'
import {
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  StylePool,
  setCellAt,
} from '../../src/ink/screen.js'

function makeScreen(w: number, h: number) {
  const styles = new StylePool()
  const chars = new CharPool()
  const hyperlinks = new HyperlinkPool()
  return { screen: createScreen(w, h, styles, chars, hyperlinks), styles, chars, hyperlinks }
}

describe('Output.get() switch fall-through regression', () => {
  test('shift 后不应 fall-through 到 write（不崩溃）', () => {
    const { screen, styles, chars, hyperlinks } = makeScreen(20, 10)
    const output = new Output({ width: 20, height: 10, stylePool: styles, screen })

    // 先写一些内容
    output.write(0, 0, 'line0')
    output.write(0, 1, 'line1')
    output.write(0, 2, 'line2')

    // shift 操作 — 修复前会 fall-through 到 write 导致 undefined.split('\n') 崩溃
    output.shift(0, 5, 1)

    // write 后续内容
    output.write(0, 5, 'after-shift')

    // 不应抛出异常
    expect(() => output.get()).not.toThrow()
  })

  test('blit 后不应 fall-through 到 write（不崩溃）', () => {
    const { screen: srcScreen } = makeScreen(20, 10)
    const { screen, styles } = makeScreen(20, 10)
    const output = new Output({ width: 20, height: 10, stylePool: styles, screen })

    // 先写一些内容到 src screen
    // blit 从 srcScreen 复制区域到 output 的 screen
    output.blit(srcScreen, 0, 0, 10, 5)

    // 后续 write
    output.write(0, 6, 'after-blit')

    // 不应抛出异常
    expect(() => output.get()).not.toThrow()
  })

  test('blit + shift + write 混合操作序列正确执行', () => {
    const { screen: srcScreen, chars: srcChars } = makeScreen(20, 10)
    const { screen, styles, chars } = makeScreen(20, 10)
    const output = new Output({ width: 20, height: 10, stylePool: styles, screen })

    // 模拟多智能体场景：blit 缓存内容 → shift 滚动 → write 新内容
    output.write(0, 0, 'agent-1-output')
    output.blit(srcScreen, 0, 0, 20, 3)
    output.shift(0, 8, 2)
    output.write(0, 7, 'agent-2-output')

    const result = output.get()

    // screen 应该被正常返回，不是 undefined
    expect(result).toBeDefined()
    expect(result.width).toBe(20)
    expect(result.height).toBe(10)

    // 验证最后一个 write 的内容确实被写入
    const char = charInCellAt(result, 0, 7)
    expect(char).toBe('a') // 'agent-2-output' 的首字符
  })

  test('连续多个 shift 不崩溃', () => {
    const { screen, styles } = makeScreen(20, 10)
    const output = new Output({ width: 20, height: 10, stylePool: styles, screen })

    output.write(0, 0, 'hello')
    output.shift(0, 9, 1)
    output.shift(0, 9, 1)
    output.shift(0, 9, 1)
    output.write(0, 7, 'world')

    expect(() => output.get()).not.toThrow()
  })

  test('连续多个 blit 不崩溃', () => {
    const { screen: src1 } = makeScreen(20, 10)
    const { screen: src2 } = makeScreen(20, 10)
    const { screen, styles } = makeScreen(20, 10)
    const output = new Output({ width: 20, height: 10, stylePool: styles, screen })

    output.blit(src1, 0, 0, 10, 5)
    output.blit(src2, 0, 5, 10, 5)
    output.write(0, 3, 'middle')

    expect(() => output.get()).not.toThrow()
  })
})
