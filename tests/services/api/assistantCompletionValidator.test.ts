import { describe, expect, test } from 'bun:test'
import {
  sanitizeAssistantCompletionContent,
  stripThinkingMarkupForVisibleText,
  stripThinkingTagsFromText,
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

  test('声明 tool_use 但没有工具块时判定为可重试异常', () => {
    const content: AssistantContentBlock[] = [
      { type: 'thinking', thinking: 'run a command', signature: '' },
    ]

    expect(validateAssistantCompletion({ content, stopReason: 'tool_use' })).toEqual({
      ok: false,
      reason: 'tool_use_without_tool_call',
    })
  })

  test('声明 tool_use 且存在工具块时判定为有效', () => {
    const content: AssistantContentBlock[] = [
      { type: 'tool_call', id: 'call_1', name: 'Bash', input: { command: 'pwd' } },
    ]

    expect(validateAssistantCompletion({ content, stopReason: 'tool_use' })).toEqual({ ok: true })
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

  test('流式标签清理只剥离标签本身', () => {
    expect(stripThinkingTagsFromText('</think>\nanswer')).toBe('answer')
    expect(stripThinkingTagsFromText('<think>hidden')).toBe('hidden')
    expect(stripThinkingTagsFromText('\n\n---\n\n')).toBe('\n\n---\n\n')
  })

  test('标准 content 清理不依赖 provider 配置', () => {
    const content: AssistantContentBlock[] = [
      { type: 'text', text: '<think>hidden</think>' },
      { type: 'text', text: '<thinking>secret</thinking>\nanswer' },
      { type: 'thinking', thinking: 'kept as thinking block', signature: '' },
    ]

    expect(sanitizeAssistantCompletionContent(content)).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'kept as thinking block', signature: '' },
    ])
  })
})
