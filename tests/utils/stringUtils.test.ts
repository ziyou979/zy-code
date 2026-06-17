/**
 * stringUtils 测试：通用字符串工具函数与 EndTruncatingAccumulator。
 *
 * 重点关注：
 * - escapeRegExp 对所有 regex 元字符的转义
 * - capitalize 只改首字母
 * - plural 的单复数选择
 * - firstLineOf 的换行切分
 * - countCharInString 的计数逻辑
 * - normalizeFullWidthDigits / normalizeFullWidthSpace 的全角→半角转换
 * - safeJoinLines 的截断逻辑
 * - truncateToLines 的行数限制
 * - EndTruncatingAccumulator 的溢出和清空行为
 */
import { describe, expect, test } from 'bun:test'
import {
  capitalize,
  countCharInString,
  EndTruncatingAccumulator,
  escapeRegExp,
  firstLineOf,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  plural,
  safeJoinLines,
  truncateToLines,
} from '../../src/utils/stringUtils.js'

describe('stringUtils', () => {
  describe('escapeRegExp', () => {
    test('空字符串不变', () => {
      expect(escapeRegExp('')).toBe('')
    })

    test('无元字符原样返回', () => {
      expect(escapeRegExp('hello')).toBe('hello')
    })

    test('所有 regex 元字符被转义', () => {
      const metaChars = '.*+?^${}()|[]\\'
      const escaped = escapeRegExp(metaChars)
      const re = new RegExp(escaped)
      expect(re.test(metaChars)).toBe(true)
    })

    test('混合文本中的元字符被转义', () => {
      expect(escapeRegExp('file.ts')).toBe('file\\.ts')
      expect(escapeRegExp('a[0]')).toBe('a\\[0\\]')
      expect(escapeRegExp('price: $100')).toBe('price: \\$100')
    })
  })

  describe('capitalize', () => {
    test('空字符串不变', () => {
      expect(capitalize('')).toBe('')
    })

    test('首字母小写→大写', () => {
      expect(capitalize('hello')).toBe('Hello')
    })

    test('不改变其余字符（与 lodash 不同）', () => {
      expect(capitalize('fooBar')).toBe('FooBar')
    })

    test('单字符', () => {
      expect(capitalize('a')).toBe('A')
    })

    test('已经大写的不变', () => {
      expect(capitalize('Hello')).toBe('Hello')
    })
  })

  describe('plural', () => {
    test('n=1 返回单数', () => {
      expect(plural(1, 'file')).toBe('file')
    })

    test('n=0 返回复数', () => {
      expect(plural(0, 'file')).toBe('files')
    })

    test('n>1 返回复数', () => {
      expect(plural(3, 'file')).toBe('files')
    })

    test('自定义复数形式', () => {
      expect(plural(2, 'entry', 'entries')).toBe('entries')
    })

    test('自定义复数 n=1 仍返回单数', () => {
      expect(plural(1, 'entry', 'entries')).toBe('entry')
    })
  })

  describe('firstLineOf', () => {
    test('无换行返回原字符串', () => {
      expect(firstLineOf('hello world')).toBe('hello world')
    })

    test('有换行返回第一行', () => {
      expect(firstLineOf('line1\nline2\nline3')).toBe('line1')
    })

    test('空字符串', () => {
      expect(firstLineOf('')).toBe('')
    })

    test('以换行开头返回空字符串', () => {
      expect(firstLineOf('\nline2')).toBe('')
    })

    test('单行无内容只有换行', () => {
      expect(firstLineOf('\n')).toBe('')
    })
  })

  describe('countCharInString', () => {
    test('空字符串返回 0', () => {
      expect(countCharInString('', 'a')).toBe(0)
    })

    test('无匹配返回 0', () => {
      expect(countCharInString('hello', 'x')).toBe(0)
    })

    test('计数正确', () => {
      expect(countCharInString('banana', 'a')).toBe(3)
    })

    test('start 参数跳过前部', () => {
      expect(countCharInString('banana', 'a', 2)).toBe(2)
    })

    test('换行符计数', () => {
      expect(countCharInString('a\nb\nc\n', '\n')).toBe(3)
    })
  })

  describe('normalizeFullWidthDigits', () => {
    test('全角数字→半角', () => {
      expect(normalizeFullWidthDigits('０１２３４５６７８９')).toBe('0123456789')
    })

    test('混合文本只转换数字', () => {
      expect(normalizeFullWidthDigits('价格：１２３元')).toBe('价格：123元')
    })

    test('无全角数字不变', () => {
      expect(normalizeFullWidthDigits('hello 123')).toBe('hello 123')
    })
  })

  describe('normalizeFullWidthSpace', () => {
    test('全角空格→半角', () => {
      expect(normalizeFullWidthSpace('hello　world')).toBe('hello world')
    })

    test('多个全角空格', () => {
      expect(normalizeFullWidthSpace('　　')).toBe('  ')
    })

    test('无全角空格不变', () => {
      expect(normalizeFullWidthSpace('hello world')).toBe('hello world')
    })
  })

  describe('safeJoinLines', () => {
    test('空数组返回空字符串', () => {
      expect(safeJoinLines([])).toBe('')
    })

    test('单元素无分隔符', () => {
      expect(safeJoinLines(['hello'])).toBe('hello')
    })

    test('默认逗号分隔', () => {
      expect(safeJoinLines(['a', 'b', 'c'])).toBe('a,b,c')
    })

    test('自定义分隔符', () => {
      expect(safeJoinLines(['a', 'b'], '\n')).toBe('a\nb')
    })

    test('超过 maxSize 截断并添加标记', () => {
      const result = safeJoinLines(['abcde', 'fghij', 'klmno'], ',', 12)
      expect(result).toContain('...[truncated]')
      expect(result.length).toBeLessThanOrEqual(12 + '...[truncated]'.length)
    })

    test('恰好填满 maxSize 不截断', () => {
      expect(safeJoinLines(['abc'], ',', 3)).toBe('abc')
    })
  })

  describe('truncateToLines', () => {
    test('行数不超限不截断', () => {
      expect(truncateToLines('a\nb\nc', 3)).toBe('a\nb\nc')
    })

    test('超限截断并添加省略号', () => {
      expect(truncateToLines('a\nb\nc\nd', 2)).toBe('a\nb…')
    })

    test('空字符串', () => {
      expect(truncateToLines('', 5)).toBe('')
    })

    test('单行不截断', () => {
      expect(truncateToLines('hello', 1)).toBe('hello')
    })

    test('maxLines=0 截断全部', () => {
      expect(truncateToLines('a\nb', 0)).toBe('…')
    })
  })

  describe('EndTruncatingAccumulator', () => {
    test('正常累积未超限', () => {
      const acc = new EndTruncatingAccumulator(100)
      acc.append('hello ')
      acc.append('world')
      expect(acc.toString()).toBe('hello world')
      expect(acc.truncated).toBe(false)
      expect(acc.length).toBe(11)
      expect(acc.totalBytes).toBe(11)
    })

    test('超限截断', () => {
      const acc = new EndTruncatingAccumulator(10)
      acc.append('hello')
      acc.append(' world!!!')
      expect(acc.truncated).toBe(true)
      expect(acc.length).toBe(10)
      expect(acc.toString()).toContain('hello worl')
      expect(acc.toString()).toContain('[output truncated')
    })

    test('超限后继续 append 不增长', () => {
      const acc = new EndTruncatingAccumulator(5)
      acc.append('12345')
      acc.append('67890')
      expect(acc.length).toBe(5)
      acc.append('more')
      expect(acc.length).toBe(5)
    })

    test('clear 重置所有状态', () => {
      const acc = new EndTruncatingAccumulator(5)
      acc.append('12345678')
      expect(acc.truncated).toBe(true)
      acc.clear()
      expect(acc.truncated).toBe(false)
      expect(acc.length).toBe(0)
      expect(acc.totalBytes).toBe(0)
      expect(acc.toString()).toBe('')
    })

    test('Buffer 输入也能正常工作', () => {
      const acc = new EndTruncatingAccumulator(100)
      acc.append(Buffer.from('hello'))
      expect(acc.toString()).toBe('hello')
    })

    test('totalBytes 跟踪所有输入（含截断部分）', () => {
      const acc = new EndTruncatingAccumulator(5)
      acc.append('12345')
      acc.append('67890')
      expect(acc.totalBytes).toBe(10)
    })
  })
})
