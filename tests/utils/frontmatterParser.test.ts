/**
 * frontmatterParser 测试：Markdown frontmatter 解析与路径分割。
 *
 * 重点关注：
 * - parseFrontmatter 正常提取 / 无 frontmatter / YAML 特殊字符
 * - splitPathInFrontmatter 逗号分割与花括号展开
 * - parsePositiveIntFromFrontmatter 各种输入类型
 * - coerceDescriptionToString 类型强制转换
 * - parseBooleanFrontmatter 严格布尔判定
 * - parseShellFrontmatter 有效/无效 shell 值
 */
import { describe, expect, test } from 'bun:test'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parsePositiveIntFromFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from '../../src/utils/frontmatterParser.js'

describe('frontmatterParser', () => {
  describe('parseFrontmatter', () => {
    test('标准 frontmatter 提取', () => {
      const md = `---
description: A test skill
model: compact
---
# Hello
Content here`
      const result = parseFrontmatter(md)
      expect(result.frontmatter.description).toBe('A test skill')
      expect(result.frontmatter.model).toBe('compact')
      expect(result.content).toBe('# Hello\nContent here')
    })

    test('无 frontmatter 返回空对象', () => {
      const result = parseFrontmatter('# Just a heading\nSome text')
      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe('# Just a heading\nSome text')
    })

    test('空 frontmatter', () => {
      const md = `---
---
Content`
      const result = parseFrontmatter(md)
      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe('Content')
    })

    test('frontmatter 值为 null（key: 无值）', () => {
      const md = `---
description:
---
Content`
      const result = parseFrontmatter(md)
      expect(result.frontmatter.description).toBeNull()
    })

    test('frontmatter 含 YAML 特殊字符（自动加引号重试）', () => {
      const md = `---
paths: src/**/*.{ts,tsx}
---
Content`
      const result = parseFrontmatter(md)
      expect(result.frontmatter.paths).toBeDefined()
      expect(result.content).toBe('Content')
    })
  })

  describe('splitPathInFrontmatter', () => {
    test('简单逗号分割', () => {
      expect(splitPathInFrontmatter('a, b, c')).toEqual(['a', 'b', 'c'])
    })

    test('花括号内逗号不作为分隔符', () => {
      expect(splitPathInFrontmatter('src/*.{ts,tsx}')).toEqual(['src/*.ts', 'src/*.tsx'])
    })

    test('多组花括号展开（笛卡尔积）', () => {
      expect(splitPathInFrontmatter('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d'])
    })

    test('逗号分割 + 花括号展开组合', () => {
      expect(splitPathInFrontmatter('a, src/*.{ts,tsx}')).toEqual(['a', 'src/*.ts', 'src/*.tsx'])
    })

    test('无花括号原样返回', () => {
      expect(splitPathInFrontmatter('src/index.ts')).toEqual(['src/index.ts'])
    })

    test('数组输入递归展开', () => {
      expect(splitPathInFrontmatter(['a', 'src/*.{ts,tsx}'])).toEqual([
        'a',
        'src/*.ts',
        'src/*.tsx',
      ])
    })

    test('空字符串返回空数组', () => {
      expect(splitPathInFrontmatter('')).toEqual([])
    })

    test('非字符串非数组返回空数组', () => {
      expect(splitPathInFrontmatter(123 as unknown as string)).toEqual([])
    })
  })

  describe('parsePositiveIntFromFrontmatter', () => {
    test('正整数 number 类型', () => {
      expect(parsePositiveIntFromFrontmatter(5)).toBe(5)
    })

    test('正整数 string 类型', () => {
      expect(parsePositiveIntFromFrontmatter('10')).toBe(10)
    })

    test('0 返回 undefined（非正数）', () => {
      expect(parsePositiveIntFromFrontmatter(0)).toBeUndefined()
    })

    test('负数返回 undefined', () => {
      expect(parsePositiveIntFromFrontmatter(-1)).toBeUndefined()
    })

    test('小数返回 undefined', () => {
      expect(parsePositiveIntFromFrontmatter(1.5)).toBeUndefined()
    })

    test('null 返回 undefined', () => {
      expect(parsePositiveIntFromFrontmatter(null)).toBeUndefined()
    })

    test('undefined 返回 undefined', () => {
      expect(parsePositiveIntFromFrontmatter(undefined)).toBeUndefined()
    })

    test('非数字字符串返回 undefined', () => {
      expect(parsePositiveIntFromFrontmatter('abc')).toBeUndefined()
    })
  })

  describe('coerceDescriptionToString', () => {
    test('字符串原样返回（trim）', () => {
      expect(coerceDescriptionToString('  hello  ')).toBe('hello')
    })

    test('空字符串返回 null', () => {
      expect(coerceDescriptionToString('')).toBeNull()
    })

    test('纯空白返回 null', () => {
      expect(coerceDescriptionToString('   ')).toBeNull()
    })

    test('null 返回 null', () => {
      expect(coerceDescriptionToString(null)).toBeNull()
    })

    test('undefined 返回 null', () => {
      expect(coerceDescriptionToString(undefined)).toBeNull()
    })

    test('数字强制转换', () => {
      expect(coerceDescriptionToString(42)).toBe('42')
    })

    test('布尔值强制转换', () => {
      expect(coerceDescriptionToString(true)).toBe('true')
    })

    test('数组返回 null（无效类型）', () => {
      expect(coerceDescriptionToString(['a', 'b'])).toBeNull()
    })

    test('对象返回 null（无效类型）', () => {
      expect(coerceDescriptionToString({ key: 'value' })).toBeNull()
    })
  })

  describe('parseBooleanFrontmatter', () => {
    test('true → true', () => {
      expect(parseBooleanFrontmatter(true)).toBe(true)
    })

    test('"true" → true', () => {
      expect(parseBooleanFrontmatter('true')).toBe(true)
    })

    test('false → false', () => {
      expect(parseBooleanFrontmatter(false)).toBe(false)
    })

    test('"false" → false', () => {
      expect(parseBooleanFrontmatter('false')).toBe(false)
    })

    test('其他值 → false', () => {
      expect(parseBooleanFrontmatter('yes')).toBe(false)
      expect(parseBooleanFrontmatter(1)).toBe(false)
      expect(parseBooleanFrontmatter(null)).toBe(false)
      expect(parseBooleanFrontmatter(undefined)).toBe(false)
    })
  })

  describe('parseShellFrontmatter', () => {
    test('bash → "bash"', () => {
      expect(parseShellFrontmatter('bash', 'test.md')).toBe('bash')
    })

    test('powershell → "powershell"', () => {
      expect(parseShellFrontmatter('powershell', 'test.md')).toBe('powershell')
    })

    test('大小写不敏感', () => {
      expect(parseShellFrontmatter('BASH', 'test.md')).toBe('bash')
      expect(parseShellFrontmatter('PowerShell', 'test.md')).toBe('powershell')
    })

    test('null → undefined', () => {
      expect(parseShellFrontmatter(null, 'test.md')).toBeUndefined()
    })

    test('空字符串 → undefined', () => {
      expect(parseShellFrontmatter('', 'test.md')).toBeUndefined()
    })

    test('无效值 → undefined（回退 bash）', () => {
      expect(parseShellFrontmatter('zsh', 'test.md')).toBeUndefined()
    })
  })
})
