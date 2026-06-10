/**
 * json 测试：JSON / JSONL / JSONC 解析工具。
 *
 * 重点关注：
 * - safeParseJSON 正常解析、无效 JSON、null/undefined 输入、memoization
 * - safeParseJSONC 注释支持
 * - parseJSONL 多行解析、空行跳过、malformed 行跳过、BOM 处理
 * - addItemToJSONCArray 向数组追加元素
 */
import { describe, expect, test } from 'bun:test'
import {
  addItemToJSONCArray,
  parseJSONL,
  safeParseJSON,
  safeParseJSONC,
} from '../../src/utils/json.js'

describe('json', () => {
  describe('safeParseJSON', () => {
    test('有效 JSON 正常解析', () => {
      expect(safeParseJSON('{"a":1}')).toEqual({ a: 1 })
    })

    test('JSON 数组', () => {
      expect(safeParseJSON('[1,2,3]')).toEqual([1, 2, 3])
    })

    test('JSON 原始值', () => {
      expect(safeParseJSON('"hello"')).toBe('hello')
      expect(safeParseJSON('42')).toBe(42)
      expect(safeParseJSON('true')).toBe(true)
      expect(safeParseJSON('null')).toBeNull()
    })

    test('无效 JSON 返回 null', () => {
      expect(safeParseJSON('{invalid}', false)).toBeNull()
    })

    test('null 输入返回 null', () => {
      expect(safeParseJSON(null)).toBeNull()
    })

    test('undefined 输入返回 null', () => {
      expect(safeParseJSON(undefined)).toBeNull()
    })

    test('空字符串返回 null', () => {
      expect(safeParseJSON('')).toBeNull()
    })
  })

  describe('safeParseJSONC', () => {
    test('标准 JSON 正常解析', () => {
      expect(safeParseJSONC('{"a": 1}')).toEqual({ a: 1 })
    })

    test('带注释的 JSON', () => {
      const jsonc = `{
        // comment
        "a": 1,
        /* block comment */
        "b": 2
      }`
      expect(safeParseJSONC(jsonc)).toEqual({ a: 1, b: 2 })
    })

    test('尾随逗号', () => {
      expect(safeParseJSONC('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 })
    })

    test('null 输入返回 null', () => {
      expect(safeParseJSONC(null)).toBeNull()
    })

    test('空字符串返回 null', () => {
      expect(safeParseJSONC('')).toBeNull()
    })
  })

  describe('parseJSONL', () => {
    test('多行解析', () => {
      const data = '{"a":1}\n{"b":2}\n{"c":3}\n'
      expect(parseJSONL(data)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    })

    test('空行跳过', () => {
      const data = '{"a":1}\n\n{"b":2}\n\n'
      expect(parseJSONL(data)).toEqual([{ a: 1 }, { b: 2 }])
    })

    test('malformed 行跳过', () => {
      const data = '{"a":1}\n{invalid}\n{"b":2}\n'
      expect(parseJSONL(data)).toEqual([{ a: 1 }, { b: 2 }])
    })

    test('空输入返回空数组', () => {
      expect(parseJSONL('')).toEqual([])
    })

    test('单行无换行', () => {
      expect(parseJSONL('{"a":1}')).toEqual([{ a: 1 }])
    })

    test('Buffer 输入', () => {
      const buf = Buffer.from('{"a":1}\n{"b":2}\n')
      expect(parseJSONL(buf)).toEqual([{ a: 1 }, { b: 2 }])
    })

    test('Buffer 带 BOM', () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf])
      const content = Buffer.from('{"a":1}\n')
      const buf = Buffer.concat([bom, content])
      expect(parseJSONL(buf)).toEqual([{ a: 1 }])
    })
  })

  describe('addItemToJSONCArray', () => {
    test('向数组追加元素', () => {
      const content = '[\n    "a",\n    "b"\n]'
      const result = addItemToJSONCArray(content, 'c')
      const parsed = JSON.parse(result)
      expect(parsed).toEqual(['a', 'b', 'c'])
    })

    test('空数组追加', () => {
      const result = addItemToJSONCArray('[]', 'first')
      const parsed = JSON.parse(result)
      expect(parsed).toEqual(['first'])
    })

    test('空内容创建新数组', () => {
      const result = addItemToJSONCArray('', 'item')
      const parsed = JSON.parse(result)
      expect(parsed).toEqual(['item'])
    })

    test('非数组内容替换为数组', () => {
      const result = addItemToJSONCArray('{"key": "value"}', 'item')
      const parsed = JSON.parse(result)
      expect(parsed).toEqual(['item'])
    })

    test('追加对象元素', () => {
      const content = '[\n    {"name": "a"}\n]'
      const result = addItemToJSONCArray(content, { name: 'b' })
      const parsed = JSON.parse(result)
      expect(parsed).toEqual([{ name: 'a' }, { name: 'b' }])
    })
  })
})
