import { describe, expect, test } from 'bun:test'
import {
  layoutStatusbarRows,
  type Segment,
} from '../../../src/components/statusbar/renderSegments.js'

function seg(text: string, colorToken = 'text'): Segment {
  return { text, colorToken }
}

describe('layoutStatusbarRows', () => {
  test('宽度充足时单行放下全部段', () => {
    const segments = [seg('aaa'), seg('bbb'), seg('ccc')]
    const rows = layoutStatusbarRows(segments, 40)
    expect(rows).toEqual([segments])
  })

  test('一行装不下时贪心换行到第二行', () => {
    // 'aaa' + ' │ '(3) + 'bbb' = 8 列；再加 ' │ ccc' 超出 11 列
    const rows = layoutStatusbarRows([seg('aaa'), seg('bbb'), seg('ccc')], 11)
    expect(rows).toEqual([[seg('aaa'), seg('bbb')], [seg('ccc')]])
  })

  test('maxRows=2 时第二行也装不下的尾部段被丢弃', () => {
    // 8 列：行1=[aaa]（3 列），bbb 换行；行2=[bbb] 后 ccc 需 9>8，到行数上限丢弃
    const rows = layoutStatusbarRows([seg('aaa'), seg('bbb'), seg('ccc'), seg('ddd')], 8)
    expect(rows).toEqual([[seg('aaa')], [seg('bbb')]])
  })

  test('默认最多两行：一行可放下时不再换行', () => {
    const rows = layoutStatusbarRows([seg('aaa'), seg('bbb'), seg('ccc')], 60)
    expect(rows).toHaveLength(1)
  })

  test('单个超宽段在空行时无条件放入（由调用方 truncate 兜底）', () => {
    const rows = layoutStatusbarRows([seg('x'.repeat(50))], 10)
    expect(rows).toEqual([[seg('x'.repeat(50))]])
  })

  test('空段列表返回空行集', () => {
    expect(layoutStatusbarRows([], 80)).toEqual([])
  })

  test('超宽段独占一行后，后续段从下一行重新装填', () => {
    // 第一行：wide 段（超宽独占）；第二行：aaa
    const rows = layoutStatusbarRows([seg('x'.repeat(20)), seg('aaa')], 10)
    expect(rows).toEqual([[seg('x'.repeat(20))], [seg('aaa')]])
  })

  test('maxRows=1 时退化为原"从末尾丢弃"语义', () => {
    const rows = layoutStatusbarRows([seg('aaa'), seg('bbb'), seg('ccc')], 11, 1)
    expect(rows).toEqual([[seg('aaa'), seg('bbb')]])
  })

  test('第二行装不下首段时丢弃首段，但保留第一行完整内容', () => {
    // 第一行 'aaa bbb' 恰好占满；ccc 换行后 second 行已到 maxRows 上限被丢弃
    const rows = layoutStatusbarRows([seg('aaa'), seg('bbb'), seg('ccc')], 7)
    // 7 列只够 'aaa │ ' + 3 = 不行 → aaa 单独一行？宽度: aaa=3, +sep+bbb=9>7
    // → 行1=[aaa]，行2=[bbb]，ccc 丢弃
    expect(rows).toEqual([[seg('aaa')], [seg('bbb')]])
  })
})
