import { describe, expect, test } from 'bun:test'
import {
  CharPool,
  countWideCellsInRowBefore,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../../src/ink/screen.js'
import {
  createSelectionState,
  finishSelection,
  getSelectedText,
  startSelection,
  updateSelection,
} from '../../src/ink/selection.js'

describe('JetBrains 终端列坐标', () => {
  test('应在终端列和内部单元格列之间正确换算 CJK 宽字符', () => {
    const styles = new StylePool()
    const screen = createScreen(8, 1, styles, new CharPool(), new HyperlinkPool())
    setCellAt(screen, 0, 0, { char: '中', styleId: styles.none, width: 1, hyperlink: undefined })
    setCellAt(screen, 2, 0, { char: '文', styleId: styles.none, width: 1, hyperlink: undefined })

    // JediTerm 看到“中文a”的 a 位于第 2 列；内部缓冲区位于第 4 单元格。
    expect(countWideCellsInRowBefore(screen, 0, 2)).toBe(2)
  })

  test('复制选区应跳过宽字符的 spacer 单元格且与高亮范围一致', () => {
    const styles = new StylePool()
    const screen = createScreen(8, 1, styles, new CharPool(), new HyperlinkPool())
    setCellAt(screen, 0, 0, { char: '中', styleId: styles.none, width: 1, hyperlink: undefined })
    setCellAt(screen, 2, 0, { char: 'a', styleId: styles.none, width: 0, hyperlink: undefined })
    setCellAt(screen, 3, 0, { char: 'b', styleId: styles.none, width: 0, hyperlink: undefined })

    const selection = createSelectionState()
    startSelection(selection, 2, 0)
    updateSelection(selection, 3, 0)
    finishSelection(selection)

    expect(getSelectedText(selection, screen)).toBe('ab')
  })
})
