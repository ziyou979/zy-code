import { describe, expect, test } from 'bun:test'
import { getInputSelectionOffsets } from '../../../src/components/PromptInput/inputSelection.js'

const inputRect = { x: 2, y: 10, width: 8, height: 3 }

describe('getInputSelectionOffsets', () => {
  test('将跨软换行选区映射为连续输入偏移', () => {
    expect(
      getInputSelectionOffsets({
        input: 'abcdefghij',
        columns: 6,
        cursorOffset: 10,
        inputRect,
        bounds: {
          start: { col: 5, row: 10 },
          end: { col: 4, row: 11 },
        },
      }),
    ).toEqual({ start: 3, end: 8 })
  })

  test('跨显式换行选择字符时保留未选中的换行符', () => {
    expect(
      getInputSelectionOffsets({
        input: 'abc\ndef',
        columns: 6,
        cursorOffset: 7,
        inputRect,
        bounds: {
          start: { col: 3, row: 10 },
          end: { col: 3, row: 11 },
        },
      }),
    ).toEqual({ start: 1, end: 6 })
  })

  test('正确处理跨行宽字符和提示符区域', () => {
    expect(
      getInputSelectionOffsets({
        input: '你好世界',
        columns: 6,
        cursorOffset: 4,
        inputRect,
        bounds: {
          start: { col: 0, row: 10 },
          end: { col: 5, row: 11 },
        },
      }),
    ).toEqual({ start: 0, end: 4 })
  })

  test('选区端点不在输入框行内时拒绝删除', () => {
    expect(
      getInputSelectionOffsets({
        input: 'abcdefghij',
        columns: 6,
        cursorOffset: 10,
        inputRect,
        bounds: {
          start: { col: 3, row: 9 },
          end: { col: 4, row: 10 },
        },
      }),
    ).toBeNull()
  })
})
