import { describe, expect, test } from 'bun:test'
import {
  stripThinkingMarkupForVisibleText,
  validateAssistantCompletion,
} from '../../../src/services/api/assistantCompletionValidator.js'
import type { AssistantContentBlock } from '../../../src/types/llm.js'

describe('assistantCompletionValidator', () => {
  test('只有 thinking 且正常结束时判定为可重试异常', () => {
    const content: AssistantContentBlock[] = [
      { type: 'thinking', thinking: 'let me inspect this', signature: '' },
    ]

    expect(validateAssistantCompletion({ content, stopReason: 'end_turn' })).toEqual({
      ok: false,
      reason: 'thinking_only',
    })
  })

  test('只有 think 标签文本时判定为可重试异常', () => {
    const content: AssistantContentBlock[] = [{ type: 'text', text: '<think>hidden</think>' }]

    expect(validateAssistantCompletion({ content, stopReason: 'end_turn' })).toEqual({
      ok: false,
      reason: 'thinking_tag_only',
    })
  })

  test('think 标签后仍有可见文本时判定为有效', () => {
    const content: AssistantContentBlock[] = [
      { type: 'text', text: '<think>hidden</think>\nvisible answer' },
    ]

    expect(validateAssistantCompletion({ content, stopReason: 'end_turn' })).toEqual({ ok: true })
  })

  test('存在工具调用时判定为有效', () => {
    const content: AssistantContentBlock[] = [
      { type: 'thinking', thinking: 'use tool', signature: '' },
      { type: 'tool_call', id: 'call_1', name: 'Bash', input: {} },
    ]

    expect(validateAssistantCompletion({ content, stopReason: 'end_turn' })).toEqual({ ok: true })
  })

  test('非 end_turn 停止原因不触发可见内容校验', () => {
    expect(validateAssistantCompletion({ content: [], stopReason: 'max_tokens' })).toEqual({
      ok: true,
    })
  })

  test('剥离完整 thinking 标签和孤立标签', () => {
    expect(stripThinkingMarkupForVisibleText('<thinking>secret</thinking>\nanswer')).toBe('answer')
    expect(stripThinkingMarkupForVisibleText('</think>')).toBe('')
  })
})
