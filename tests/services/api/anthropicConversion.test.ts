/**
 * 入站测试：Anthropic SDK 流式/非流式响应 → 标准 LLMResponse / LLMStreamEvent
 * 被测函数：streamAdapter.ts
 *   - anthropicLLMStreamEventToStandard
 *   - anthropicStreamToStandard
 *   - anthropicResponseToStandard
 *
 * 重点关注：
 * - tool_use → tool_call 类型映射
 * - input_json_delta → partialJson（驼峰）
 * - usage 字段映射：inputTokens/outputTokens 驼峰，cache_creation/cache_read 进 extras
 */
import { describe, expect, test } from 'bun:test'
import {
  anthropicDeltaUsageToStandard,
  anthropicResponseToStandard,
  anthropicStopReasonToStandard,
  anthropicLLMStreamEventToStandard,
  anthropicStreamToStandard,
  anthropicUsageToStandard,
  buildAnthropicCreateParams,
  messagesToAnthropic,
  toolChoiceToAnthropic,
  toolsToAnthropic,
} from '../../../src/services/api/conversions/anthropic.js'
import type { LLMStreamEvent } from '../../../src/types/llm.js'

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = []
  for await (const e of stream) {
    out.push(e)
  }
  return out
}

describe('anthropicLLMStreamEventToStandard: 单事件映射', () => {
  test('message_start → response_start', () => {
    const e = anthropicLLMStreamEventToStandard({
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
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) as any
    expect(e.type).toBe('chunk_start')
    expect(e.index).toBe(0)
    expect(e.chunk).toEqual({ type: 'text', text: '' })
  })

  test('content_block_start (tool_use) → chunk_start tool_call (类型被映射)', () => {
    const e = anthropicLLMStreamEventToStandard({
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
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    }) as any
    expect(e.chunk.type).toBe('thinking')
    expect(e.chunk.thinking).toBe('hmm')
    expect(e.chunk.signature).toBe('sig')
  })

  test('content_block_delta (input_json_delta)：partial_json → partialJson 驼峰', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    }) as any
    expect(e.type).toBe('chunk_delta')
    expect(e.delta).toEqual({ type: 'input_json_delta', partialJson: '{"q":' })
  })

  test('content_block_delta (text_delta) → text_delta', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    }) as any
    expect(e.delta).toEqual({ type: 'text_delta', text: 'hi' })
  })

  test('content_block_delta (thinking_delta) → thinking_delta', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'so' },
    }) as any
    expect(e.delta.type).toBe('thinking_delta')
    expect((e.delta as any).thinking).toBe('so')
  })

  test('message_delta → response_delta，stop_reason 透传', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 12 },
    }) as any
    expect(e.type).toBe('response_delta')
    expect(e.stopReason).toBe('tool_use')
    expect(e.usage.outputTokens).toBe(12)
  })

  test('message_stop → response_stop', () => {
    const e = anthropicLLMStreamEventToStandard({ type: 'message_stop' })
    expect(e).toEqual({ type: 'response_stop' })
  })

  test('未知事件 → 安全降级为 response_stop', () => {
    const e = anthropicLLMStreamEventToStandard({ type: '__unknown__' })
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

  test('cache tokens 提到顶层字段', () => {
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
    expect(r.usage.cacheCreationInputTokens).toBe(100)
    expect(r.usage.cacheReadInputTokens).toBe(50)
  })
})

describe('messagesToAnthropic: 出站 Anthropic 消息构造', () => {
  test('纯 user → assistant 对话：原样转换', () => {
    const result = messagesToAnthropic([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as any)
    // system 消息被过滤（由顶层 system 字段处理）
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
  })

  test('role:tool 消息 → pendingToolResults，嵌入 user 消息', () => {
    const result = messagesToAnthropic([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'result' },
      { role: 'user', content: 'continue' },
    ] as any)
    // tool 消息被嵌入 user 消息中
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('assistant')
    expect(result[1].role).toBe('user')
    const userContent = result[1].content as any[]
    expect(userContent[0].type).toBe('tool_result')
    expect(userContent[0].tool_use_id).toBe('c')
    expect(userContent[0].content).toBe('result')
    expect(userContent[1].type).toBe('text')
    expect(userContent[1].text).toBe('continue')
  })

  test('role:tool 标记 isError → 透传 is_error: true', () => {
    const result = messagesToAnthropic([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'error', isError: true },
      { role: 'user', content: '' },
    ] as any)
    const userContent = result[1].content as any[]
    expect(userContent[0].is_error).toBe(true)
  })

  test('assistant 后跟 tool 但无后续 user：pendingToolResults 在末尾 flush', () => {
    const result = messagesToAnthropic([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'result' },
    ] as any)
    expect(result).toHaveLength(2)
    expect(result[1].role).toBe('user')
    expect((result[1].content as any[])[0].type).toBe('tool_result')
  })

  test('user 消息内容为空数组：返回空数组', () => {
    const result = messagesToAnthropic([{ role: 'user', content: [] }] as any)
    expect(result[0].content).toEqual([])
  })

  test('assistant content 为 null 但有 toolCalls：从 toolCalls 构造 tool_use', () => {
    const result = messagesToAnthropic([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }],
      },
    ] as any)
    const content = result[0].content as any[]
    expect(content[0].type).toBe('tool_use')
    expect(content[0].id).toBe('c')
    expect(content[0].name).toBe('f')
    expect(content[0].input).toEqual({})
  })

  test('assistant text + tool_call block：文本和 tool_use 并存', () => {
    const result = messagesToAnthropic([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_call', id: 'c', name: 'f', input: { x: 1 } },
        ],
      },
    ] as any)
    const content = result[0].content as any[]
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: 'Let me check' })
    expect(content[1].type).toBe('tool_use')
    expect(content[1].input).toEqual({ x: 1 })
  })

  test('assistant content 为空字符串：转为空字符串', () => {
    const result = messagesToAnthropic([{ role: 'assistant', content: '' }] as any)
    expect(result[0].content).toBe('')
  })
})

describe('blockToAnthropic（通过 buildAnthropicCreateParams 间接测）', () => {
  test('thinking block → Anthropic thinking 格式', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning...', signature: 'sig' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[0].thinking).toBe('reasoning...')
    expect(blocks[0].signature).toBe('sig')
    expect(blocks[1].type).toBe('text')
  })

  test('image block → Anthropic image source 格式', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', mimeType: 'image/png', data: 'AAA' },
          ],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'user')!
    const blocks = msg.content as any[]
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'AAA',
    })
  })

  test('redacted_thinking block → Anthropic redacted_thinking 格式', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'redacted' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].type).toBe('redacted_thinking')
    expect(blocks[0].data).toBe('redacted')
  })

  test('未知 block 类型 → 兜底 JSON.stringify', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'unknown_block', foo: 'bar' }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('unknown_block')
  })

  test('text block 保留 cache_control', () => {
    const cc = { type: 'ephemeral' }
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: cc }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'user')!
    const blocks = msg.content as any[]
    expect(blocks[0].cache_control).toEqual(cc)
  })

  test('tool_use block 保留 cache_control', () => {
    const cc = { type: 'ephemeral' }
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: {}, cache_control: cc }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].cache_control).toEqual(cc)
  })

  test('无 cache_control 的 block 不添加该字段', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'no cache' }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'user')!
    const blocks = msg.content as any[]
    expect(blocks[0]).not.toHaveProperty('cache_control')
  })

  test('image block 保留 cache_control', () => {
    const cc = { type: 'ephemeral' }
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/png', data: 'AAA', cache_control: cc }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'user')!
    const blocks = msg.content as any[]
    expect(blocks[0].cache_control).toEqual(cc)
  })

  test('多 block 消息只有最后一个带 cache_control', () => {
    const cc = { type: 'ephemeral' }
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'last', cache_control: cc },
          ],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'user')!
    const blocks = msg.content as any[]
    expect(blocks[0]).not.toHaveProperty('cache_control')
    expect(blocks[1].cache_control).toEqual(cc)
  })
})

describe('toolChoiceToAnthropic', () => {
  test('undefined → undefined', () => {
    expect(toolChoiceToAnthropic(undefined)).toBeUndefined()
  })

  test('auto → { type: "auto" }', () => {
    expect(toolChoiceToAnthropic({ type: 'auto' })).toEqual({ type: 'auto' })
  })

  test('none → { type: "none" }', () => {
    expect(toolChoiceToAnthropic({ type: 'none' })).toEqual({ type: 'none' })
  })

  test('tool → { type: "tool", name }', () => {
    expect(toolChoiceToAnthropic({ type: 'tool', name: 'search' })).toEqual({
      type: 'tool',
      name: 'search',
    })
  })

  test('未知 type → undefined', () => {
    expect(toolChoiceToAnthropic({ type: 'unknown' } as any)).toBeUndefined()
  })
})

describe('anthropicStopReasonToStandard', () => {
  test('end_turn → end_turn', () => {
    expect(anthropicStopReasonToStandard('end_turn')).toBe('end_turn')
  })

  test('stop_sequence → end_turn', () => {
    expect(anthropicStopReasonToStandard('stop_sequence')).toBe('end_turn')
  })

  test('max_tokens → max_tokens', () => {
    expect(anthropicStopReasonToStandard('max_tokens')).toBe('max_tokens')
  })

  test('tool_use → tool_use', () => {
    expect(anthropicStopReasonToStandard('tool_use')).toBe('tool_use')
  })

  test('null → null', () => {
    expect(anthropicStopReasonToStandard(null)).toBe(null)
  })

  test('undefined → null', () => {
    expect(anthropicStopReasonToStandard(undefined)).toBe(null)
  })

  test('未知值 → null', () => {
    expect(anthropicStopReasonToStandard('unknown_reason')).toBe(null)
  })
})

describe('anthropicUsageToStandard', () => {
  test('server_tool_use_input_tokens → extras.serverToolUseInputTokens', () => {
    const usage = anthropicUsageToStandard({
      input_tokens: 10,
      output_tokens: 20,
      server_tool_use_input_tokens: 5,
    })
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(20)
    expect(usage.extras?.serverToolUseInputTokens).toBe(5)
  })

  test('input_tokens 缺失 → 默认 0', () => {
    expect(anthropicUsageToStandard({ output_tokens: 20 }).inputTokens).toBe(0)
  })

  test('undefined usage → 全零', () => {
    const usage = anthropicUsageToStandard(undefined)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })
})

describe('anthropicDeltaUsageToStandard', () => {
  test('cache tokens → 顶层字段', () => {
    const usage = anthropicDeltaUsageToStandard({
      output_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
    })
    expect(usage.outputTokens).toBe(5)
    expect(usage.cacheCreationInputTokens).toBe(100)
    expect(usage.cacheReadInputTokens).toBe(50)
  })

  test('undefined usage → outputTokens 0', () => {
    expect(anthropicDeltaUsageToStandard(undefined).outputTokens).toBe(0)
  })
})

describe('anthropicLLMStreamEventToStandard: 未覆盖的分支', () => {
  test('content_block_start (redacted_thinking)', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'encrypted' },
    }) as any
    expect(e.chunk.type).toBe('redacted_thinking')
    expect(e.chunk.data).toBe('encrypted')
  })

  test('content_block_start (server_tool_use)', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'server_tool_use', id: 'st_1', name: 'server_fn', input: { x: 1 } },
    }) as any
    expect(e.chunk.type).toBe('server_tool_use')
    expect(e.chunk.id).toBe('st_1')
    expect(e.chunk.name).toBe('server_fn')
    expect(e.chunk.input).toEqual({ x: 1 })
  })

  test('content_block_delta (signature_delta)', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_val' },
    }) as any
    expect(e.delta.type).toBe('signature_delta')
    expect(e.delta.signature).toBe('sig_val')
  })

  test('未知 content_block_delta 类型 → 降级 text_delta', () => {
    const e = anthropicLLMStreamEventToStandard({
      type: 'content_block_delta',
      index: 0,
      delta: { type: '__unknown_delta__', text: 'x' },
    }) as any
    expect(e.delta.type).toBe('text_delta')
  })
})

describe('anthropicResponseToStandard: 未覆盖的分支', () => {
  test('未知 block 类型 → 降级为 text 空块', () => {
    const r = anthropicResponseToStandard(
      {
        id: 'msg',
        model: 'claude',
        content: [{ type: '__unknown__' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'claude',
    )
    expect(r.content[0]).toEqual({ type: 'text', text: '' })
  })
})

describe('messagesToAnthropic: tool → assistant（无 user 介入）', () => {
  test('tool 后直接跟 assistant：pendingToolResults 被 assistant flush', () => {
    const result = messagesToAnthropic([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'result' },
      { role: 'assistant', content: 'Continuing...' },
    ] as any)
    // tool 消息被 assistant 之前 flush 为一条 user 消息
    // 结果: [assistant(tool_use), user(tool_result), assistant(continuing)]
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('assistant')
    expect((result[0].content as any[])[0].type).toBe('tool_use')

    // 第二条是 flush 出来的 user 消息
    expect(result[1].role).toBe('user')
    expect((result[1].content as any[])[0].type).toBe('tool_result')

    expect(result[2].role).toBe('assistant')
    expect(result[2].content).toBe('Continuing...')
  })
})

describe('assistantContentToAnthropic: null content 无 toolCalls', () => {
  test('content 为 null 且无 toolCalls → 空字符串', () => {
    const result = messagesToAnthropic([{ role: 'assistant', content: null }] as any)
    expect(result[0].content).toBe('')
  })
})

describe('safeParseToolArguments（通过 buildAnthropicCreateParams 间接测）', () => {
  test('tool_call input 合法且是 object → 原样使用', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'f', input: { x: 1 } }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].input).toEqual({ x: 1 })
  })

  test('tool_call input 是数字字符串（非对象 JSON）：safeParseToolArguments 返回 {}', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'f', input: '42' }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    // JSON.parse('42') 是 number，不是 object → safeParse 返回 {}
    expect(blocks[0].input).toEqual({})
  })

  test('tool_call input 是字符串（非对象 JSON 字符串）：safeParseToolArguments 返回 {}', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'f', input: '"just a string"' }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].input).toEqual({})
  })

  test('tool_call input 是非法 JSON（如缺括号）：catch 返回 {}', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'f', input: '{broken' }],
        },
      ],
    } as any)
    const msg = result.messages.find((m) => m.role === 'assistant')!
    const blocks = msg.content as any[]
    expect(blocks[0].input).toEqual({})
  })
})

describe('toolsToAnthropic', () => {
  test('undefined → undefined', () => {
    expect(toolsToAnthropic(undefined)).toBeUndefined()
  })

  test('空数组 → undefined', () => {
    expect(toolsToAnthropic([])).toBeUndefined()
  })

  test('工具定义 → Anthropic 格式', () => {
    const result = toolsToAnthropic([
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
    ])
    expect(result).toEqual([
      { name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } },
    ])
  })
})
