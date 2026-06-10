/**
 * xml 测试：XML/HTML 转义工具函数。
 *
 * 重点关注：
 * - escapeXml 对 & < > 的转义
 * - escapeXmlAttr 额外转义引号
 * - 边界：空字符串、无特殊字符、Unicode、防止双重转义
 */
import { describe, expect, test } from 'bun:test'
import { escapeXml, escapeXmlAttr } from '../../src/utils/xml.js'

describe('xml', () => {
  describe('escapeXml', () => {
    test('空字符串不变', () => {
      expect(escapeXml('')).toBe('')
    })

    test('无特殊字符原样返回', () => {
      expect(escapeXml('hello world')).toBe('hello world')
    })

    test('& 转义为 &amp;', () => {
      expect(escapeXml('a & b')).toBe('a &amp; b')
    })

    test('< 转义为 &lt;', () => {
      expect(escapeXml('a < b')).toBe('a &lt; b')
    })

    test('> 转义为 &gt;', () => {
      expect(escapeXml('a > b')).toBe('a &gt; b')
    })

    test('混合特殊字符全部转义', () => {
      expect(escapeXml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert("xss")&lt;/script&gt;',
      )
    })

    test('& 优先转义，避免破坏后续实体', () => {
      expect(escapeXml('&<>')).toBe('&amp;&lt;&gt;')
    })

    test('已有的实体引用被二次转义（防注入）', () => {
      expect(escapeXml('&amp;')).toBe('&amp;amp;')
    })

    test('Unicode 字符不受影响', () => {
      expect(escapeXml('你好 < 世界')).toBe('你好 &lt; 世界')
    })

    test('引号不在 escapeXml 范围内', () => {
      expect(escapeXml('"hello" & \'world\'')).toBe('"hello" &amp; \'world\'')
    })
  })

  describe('escapeXmlAttr', () => {
    test('空字符串不变', () => {
      expect(escapeXmlAttr('')).toBe('')
    })

    test('双引号转义为 &quot;', () => {
      expect(escapeXmlAttr('say "hello"')).toBe('say &quot;hello&quot;')
    })

    test('单引号转义为 &apos;', () => {
      expect(escapeXmlAttr("it's")).toBe('it&apos;s')
    })

    test('同时转义 & < > " \'', () => {
      expect(escapeXmlAttr('<"a" & \'b\'>')).toBe('&lt;&quot;a&quot; &amp; &apos;b&apos;&gt;')
    })

    test('无特殊字符原样返回', () => {
      expect(escapeXmlAttr('plain text')).toBe('plain text')
    })
  })
})
