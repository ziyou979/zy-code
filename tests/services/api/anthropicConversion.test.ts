/**
 * 入站测试：Anthropic SDK 流式/非流式响应 → 标准 LLMResponse / StreamEvent
 * 被测函数：streamAdapter.ts
 *   - anthropicStreamEventToStandard
 *   - anthropicStreamToStandard
 *   - anthropicResponseToStandard
 *
 * 重点关注：
 * - tool_use → tool_call 类型映射
 * - input_json_delta → partialJson（驼峰）
 * - usage 字段映射：inputTokens/outputTokens 驼峰，cache_creation/cache_read 进 extras
 */
import { describe, test, expect } from 'bun:test'
import {
  anthropicStreamEventToStandard,
  anthropicStreamToStandard,
  anthropicResponseToStandard,
} from '../../../src/services/api/conversions/anthropic.js'
import type { StreamEvent } from '../../../src/types/llm.js'

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('anthropicStreamEventToStandard: 单事件映射', () => {
  test('message_start → response_start', () => {
    const e = anthropicStreamEventToStandard({
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-3-opus' },
    })
    expect(e).toEqual({
      type: 'response_start',
      responseId: 'msg_1',
      model: 'claude-3-opus',
    })
  })

  test('content_block_start (text) → chunk_start text', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) as any
    expect(e.type).toBe('chunk_start')
    expect(e.index).toBe(0)
    expect(e.chunk).toEqual({ type: 'text', text: '' })
  })

  test('content_block_start (tool_use) → chunk_start tool_call (类型被映射)', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu', name: 'fn', input: {} },
    }) as any
    expect(e.type).toBe('chunk_start')
    expect(e.chunk.type).toBe('tool_call')
    expect(e.chunk.id).toBe('tu')
    expect(e.chunk.name).toBe('fn')
  })

  test('content_block_start (thinking) → chunk_start thinking', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    }) as any
    expect(e.chunk.type).toBe('thinking')
    expect(e.chunk.thinking).toBe('hmm')
    expect(e.chunk.signature).toBe('sig')
  })

  test('content_block_delta (input_json_delta)：partial_json → partialJson 驼峰', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    }) as any
    expect(e.type).toBe('chunk_delta')
    expect(e.delta).toEqual({ type: 'input_json_delta', partialJson: '{"q":' })
  })

  test('content_block_delta (text_delta) → text_delta', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    }) as any
    expect(e.delta).toEqual({ type: 'text_delta', text: 'hi' })
  })

  test('content_block_delta (thinking_delta) → thinking_delta', () => {
    const e = anthropicStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'so' },
    }) as any
    expect(e.delta.type).toBe('thinking_delta')
    expect((e.delta as any).thinking).toBe('so')
  })

  test('message_delta → response_delta，stop_reason 透传', () => {
    const e = anthropicStreamEventToStandard({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 12 },
    }) as any
    expect(e.type).toBe('response_delta')
    expect(e.stopReason).toBe('tool_use')
    expect(e.usage.outputTokens).toBe(12)
  })

  test('message_stop → response_stop', () => {
    const e = anthropicStreamEventToStandard({ type: 'message_stop' })
    expect(e).toEqual({ type: 'response_stop' })
  })

  test('未知事件 → 安全降级为 response_stop', () => {
    const e = anthropicStreamEventToStandard({ type: '__unknown__' })
    expect(e).toEqual({ type: 'response_stop' })
  })
})

describe('anthropicStreamToStandard: 整体流转换', () => {
  async function* fakeStream(): AsyncIterable<any> {
    yield { type: 'message_start', message: { id: 'm', model: 'claude' } }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'fn', input: {} },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 3 },
    }
    yield { type: 'message_stop' }
  }

  test('整流转换后事件序列符合预期', async () => {
    const events = await collect(anthropicStreamToStandard(fakeStream()))
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'response_start',
      'chunk_start',
      'chunk_delta',
      'chunk_stop',
      'response_delta',
      'response_stop',
    ])
    const start = events[1] as any
    expect(start.chunk.type).toBe('tool_call')
    const delta = events[2] as any
    expect(delta.delta.partialJson).toBe('{"a":1}')
  })
})

describe('anthropicResponseToStandard: 非流式响应映射', () => {
  test('text + tool_use 混合：tool_use → tool_call，input 保留 object', () => {
    const r = anthropicResponseToStandard(
      {
        id: 'msg_x',
        model: 'claude-3',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu', name: 'fn', input: { a: 1 } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 5 },
      },
      'claude-3',
    )
    expect(r.role).toBe('assistant')
    expect(r.content).toHaveLength(2)
    expect(r.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(r.content[1]).toEqual({
      type: 'tool_call',
      id: 'tu',
      name: 'fn',
      input: { a: 1 },
    })
    expect(r.stopReason).toBe('tool_use')
    expect(r.usage.inputTokens).toBe(4)
    expect(r.usage.outputTokens).toBe(5)
  })

  test('thinking 块：在非流式响应中被降级为 text 块', () => {
    const r = anthropicResponseToStandard(
      {
        id: 'msg',
        model: 'claude',
        content: [{ type: 'thinking', thinking: 'hmm' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'claude',
    )
    // 当前实现：thinking → text
    expect(r.content[0]).toEqual({ type: 'text', text: 'hmm' })
  })

  test('cache tokens 进 extras', () => {
    const r = anthropicResponseToStandard(
      {
        id: 'm',
        model: 'c',
        content: [],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
      'c',
    )
    expect(r.usage.extras).toEqual({
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 50,
    })
  })
})
