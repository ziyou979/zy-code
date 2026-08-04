import { describe, expect, test } from 'bun:test'
import {
  applyContentReplacementRecords,
  isPersistedToolResultContent,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
} from '../../../src/services/mcp/toolResultStorage.js'
import { createUserMessage } from '../../../src/services/messages/constructors.js'

describe('toolResultStorage', () => {
  test('识别已经外置的工具结果引用', () => {
    const content = `${PERSISTED_OUTPUT_TAG}\nOutput too large. Full output saved to: result.txt\n${PERSISTED_OUTPUT_CLOSING_TAG}`

    expect(isPersistedToolResultContent(content)).toBe(true)
  })

  test('不会把普通文本或内容块误判为外置结果', () => {
    expect(isPersistedToolResultContent('normal tool output')).toBe(false)
    expect(
      isPersistedToolResultContent([
        { type: 'text', text: `quoted marker: ${PERSISTED_OUTPUT_TAG}` },
      ]),
    ).toBe(false)
  })

  test('同步替换常驻消息并释放原生工具返回引用', () => {
    const rawResult = { payload: 'x'.repeat(1024) }
    const original = createUserMessage({
      content: [{ type: 'tool_result', toolCallId: 'tool-1', content: 'original' }],
      toolUseResult: rawResult,
    })

    const replaced = applyContentReplacementRecords(
      [original],
      [{ kind: 'tool-result', toolUseId: 'tool-1', replacement: '<persisted-output>ref' }],
    )

    expect(replaced[0]).not.toBe(original)
    expect(replaced[0]?.type === 'user' ? replaced[0].toolUseResult : rawResult).toBeUndefined()
    expect(replaced[0]?.type).toBe('user')
    if (replaced[0]?.type === 'user') {
      expect(replaced[0].message.content).toEqual([
        { type: 'tool_result', toolCallId: 'tool-1', content: '<persisted-output>ref' },
      ])
    }
  })

  test('重复应用同一替换记录时保留消息数组和对象引用', () => {
    const original = createUserMessage({
      content: [{ type: 'tool_result', toolCallId: 'tool-1', content: 'original' }],
      toolUseResult: { payload: 'raw' },
    })
    const records = [
      { kind: 'tool-result' as const, toolUseId: 'tool-1', replacement: '<persisted-output>ref' },
    ]

    const replaced = applyContentReplacementRecords([original], records)
    const reapplied = applyContentReplacementRecords(replaced, records)

    expect(reapplied).toBe(replaced)
    expect(reapplied[0]).toBe(replaced[0])
  })
})
