import { describe, expect, test } from 'bun:test'
import type { Frame } from '../../src/ink/frame.js'
import { LogUpdate } from '../../src/ink/logUpdate.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
  type Screen,
} from '../../src/ink/screen.js'
import { cursorPosition } from '../../src/ink/termio/csi.js'

const width = 8
const height = 2

function createFixture() {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const createTestScreen = () => createScreen(width, height, stylePool, charPool, hyperlinkPool)
  const createFrame = (screen: Screen): Frame => ({
    screen,
    viewport: { width, height },
    cursor: { x: 0, y: 0, visible: false },
  })

  return {
    stylePool,
    createTestScreen,
    createFrame,
    logUpdate: new LogUpdate({ isTTY: true, stylePool }),
  }
}

describe('LogUpdate JediTerm 宽字符重绘', () => {
  test('宽字符后继续差量写入时应使用绝对坐标重新锚定', () => {
    const { stylePool, createTestScreen, createFrame, logUpdate } = createFixture()
    const previous = createTestScreen()
    const next = createTestScreen()
    setCellAt(next, 0, 0, {
      char: '中',
      styleId: stylePool.none,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })
    setCellAt(next, 2, 0, {
      char: 'A',
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })

    const diff = logUpdate.render(
      createFrame(previous),
      createFrame(next),
      true,
      false,
      { x: 0, y: 0 },
      { anchorAfterWideCell: true },
    )
    const wideIndex = diff.findIndex((patch) => patch.type === 'stdout' && patch.content === '中')
    const anchorIndex = diff.findIndex(
      (patch) => patch.type === 'stdout' && patch.content === cursorPosition(1, 3),
    )
    const narrowIndex = diff.findIndex((patch) => patch.type === 'stdout' && patch.content === 'A')

    expect(wideIndex).toBeGreaterThanOrEqual(0)
    expect(anchorIndex).toBeGreaterThan(wideIndex)
    expect(narrowIndex).toBeGreaterThan(anchorIndex)
  })

  test('布局位移关键帧应清屏并重绘没有逻辑差异的内容', () => {
    const { stylePool, createTestScreen, createFrame, logUpdate } = createFixture()
    const previous = createTestScreen()
    const next = createTestScreen()
    for (const screen of [previous, next]) {
      setCellAt(screen, 0, 0, {
        char: 'A',
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }

    const diff = logUpdate.render(
      createFrame(previous),
      createFrame(next),
      true,
      false,
      { x: 0, y: 0 },
      { anchorAfterWideCell: true, forceFullRepaint: true },
    )

    expect(diff[0]).toMatchObject({ type: 'clearTerminal', reason: 'clear' })
    expect(diff.some((patch) => patch.type === 'stdout' && patch.content === 'A')).toBe(true)
    expect(diff.filter((patch) => patch.type === 'stdout' && patch.content === '\n')).toHaveLength(
      height - 1,
    )
  })
})
