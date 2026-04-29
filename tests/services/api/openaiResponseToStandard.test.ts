/**
 * 入站测试：OpenAI 非流式响应 → 标准 LLMResponse
 * 被测函数：streamAdapter.ts openAIResponseToStandard
 *
 * 重点关注：
 * - tool_calls 的 arguments 字符串被 JSON.parse 成对象（input 是 object）
 * - finish_reason 映射
 * - usage 同步赋值 inputTokens/outputTokens 与 deprecated input_tokens/output_tokens
 */
import { describe, test, expect } from 'bun:test'
import { openAIResponseToStandard } from '../../../src/services/api/conversions/openai.js'
import type OpenAI from 'openai'
import type { StopReason } from '../../../src/types/llm.js'

function makeCompletion(args: {
  content?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  promptTokens?: number
  completionTokens?: number
}): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'chatcmpl-x',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: args.content ?? null,
          refusal: null,
          ...(args.toolCalls && {
            tool_calls: args.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }),
        } as any,
        finish_reason: args.finishReason ?? 'stop',
        logprobs: null,
      } as any,
    ],
    usage: {
      prompt_tokens: args.promptTokens ?? 0,
      completion_tokens: args.completionTokens ?? 0,
      total_tokens: (args.promptTokens ?? 0) + (args.completionTokens ?? 0),
    },
  }
}

describe('openAIResponseToStandard: 入站 OpenAI 非流式', () => {
  test('纯文本响应：content 进入 text block', () => {
    const r = openAIResponseToStandard(makeCompletion({ content: 'hi' }), 'gpt-4')
    expect(r.role).toBe('assistant')
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(r.stopReason).toBe('end_turn')
  })

  test('工具调用：arguments 字符串被 parse 成 object input', () => {
    const r = openAIResponseToStandard(
      makeCompletion({
        toolCalls: [
          { id: 'c1', name: 'search', arguments: '{"q":"hello"}' },
        ],
        finishReason: 'tool_calls',
      }),
      'gpt-4',
    )
    expect(r.content).toHaveLength(1)
    const block = r.content[0] as any
    expect(block.type).toBe('tool_call')
    expect(block.id).toBe('c1')
    expect(block.name).toBe('search')
    expect(typeof block.input).toBe('object')
    expect(block.input).toEqual({ q: 'hello' })
    expect(r.stopReason).toBe('tool_use')
  })

  test('text + 多个 tool_call 共存', () => {
    const r = openAIResponseToStandard(
      makeCompletion({
        content: 'thinking...',
        toolCalls: [
          { id: 'a', name: 'fa', arguments: '{"x":1}' },
          { id: 'b', name: 'fb', arguments: '{"y":2}' },
        ],
        finishReason: 'tool_calls',
      }),
      'gpt-4',
    )
    expect(r.content).toHaveLength(3)
    expect(r.content[0]).toEqual({ type: 'text', text: 'thinking...' })
    expect((r.content[1] as any).input).toEqual({ x: 1 })
    expect((r.content[2] as any).input).toEqual({ y: 2 })
  })

  test('arguments 为 undefined（OpenAI 偶发会缺）：fallback 为 {}', () => {
    const r = openAIResponseToStandard(
      makeCompletion({
        toolCalls: [{ id: 'c', name: 'f', arguments: undefined as any }],
        finishReason: 'tool_calls',
      }),
      'gpt-4',
    )
    expect((r.content[0] as any).input).toEqual({})
  })

  test('usage：inputTokens / outputTokens 与 input_tokens / output_tokens 都赋值', () => {
    const r = openAIResponseToStandard(
      makeCompletion({ content: 'x', promptTokens: 11, completionTokens: 22 }),
      'gpt-4',
    )
    expect(r.usage.inputTokens).toBe(11)
    expect(r.usage.outputTokens).toBe(22)
    expect(r.usage.input_tokens).toBe(11)
    expect(r.usage.output_tokens).toBe(22)
  })

  test('finish_reason 全部分支映射', () => {
    const cases: Array<['stop' | 'tool_calls' | 'length' | 'content_filter', StopReason]> = [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'content_filter'],
    ]
    for (const [finish, expected] of cases) {
      const r = openAIResponseToStandard(
        makeCompletion({ content: 'x', finishReason: finish }),
        'gpt-4',
      )
      expect(r.stopReason).toBe(expected)
    }
  })
})
