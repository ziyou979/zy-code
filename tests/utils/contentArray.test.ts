/**
 * contentArray 测试：insertBlockAfterToolResults 的插入逻辑。
 *
 * 重点关注：
 * - 有 tool_result 块时插在最后一个之后
 * - 无 tool_result 块时插在最后一个块之前
 * - 插入块成为最后元素时自动追加 text 续接块
 * - 数组原地修改
 */
import { describe, expect, test } from 'bun:test'
import { insertBlockAfterToolResults } from '../../src/utils/contentArray.js'

describe('contentArray', () => {
  describe('insertBlockAfterToolResults', () => {
    test('有 tool_result：插在最后一个 tool_result 之后', () => {
      const content: unknown[] = [
        { type: 'tool_result', id: '1' },
        { type: 'tool_result', id: '2' },
        { type: 'text', text: 'hello' },
      ]
      const block = { type: 'cache_control', value: 'x' }

      insertBlockAfterToolResults(content, block)

      expect(content[2]).toEqual(block)
      expect(content).toHaveLength(4)
      expect((content[3] as { type: string }).type).toBe('text')
    })

    test('有 tool_result 且后面还有内容：不追加 text 续接块', () => {
      const content: unknown[] = [
        { type: 'tool_result', id: '1' },
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]
      const block = { type: 'cache_control' }

      insertBlockAfterToolResults(content, block)

      expect(content[1]).toEqual(block)
      expect(content).toHaveLength(4)
    })

    test('tool_result 是最后一个元素：插入后自动追加 text', () => {
      const content: unknown[] = [{ type: 'tool_result', id: '1' }]
      const block = { type: 'cache_control' }

      insertBlockAfterToolResults(content, block)

      expect(content).toHaveLength(3)
      expect(content[1]).toEqual(block)
      expect(content[2]).toEqual({ type: 'text', text: '.' })
    })

    test('无 tool_result：插在最后一个块之前', () => {
      const content: unknown[] = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]
      const block = { type: 'cache_control' }

      insertBlockAfterToolResults(content, block)

      expect(content[1]).toEqual(block)
      expect(content).toHaveLength(3)
      expect((content[2] as { text: string }).text).toBe('world')
    })

    test('空数组：插在 index 0', () => {
      const content: unknown[] = []
      const block = { type: 'cache_control' }

      insertBlockAfterToolResults(content, block)

      expect(content).toHaveLength(1)
      expect(content[0]).toEqual(block)
    })

    test('单元素非 tool_result：插在前面', () => {
      const content: unknown[] = [{ type: 'text', text: 'only' }]
      const block = { type: 'cache_control' }

      insertBlockAfterToolResults(content, block)

      expect(content[0]).toEqual(block)
      expect(content).toHaveLength(2)
    })

    test('多个 tool_result 散布：只看最后一个', () => {
      const content: unknown[] = [
        { type: 'tool_result', id: '1' },
        { type: 'text', text: 'mid' },
        { type: 'tool_result', id: '2' },
        { type: 'text', text: 'end' },
      ]
      const block = { type: 'inserted' }

      insertBlockAfterToolResults(content, block)

      expect(content[3]).toEqual(block)
      expect((content[2] as { id: string }).id).toBe('2')
    })
  })
})
