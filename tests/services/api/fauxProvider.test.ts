import { describe, expect, test } from 'bun:test'
import { createFauxProvider, type FauxResponse } from 'src/services/api/__test__/fauxProvider.js'
import type { LLMStreamEvent } from 'src/types/llm.js'

async function collectStream(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const e of stream) {
    events.push(e)
  }
  return events
}

describe('FauxProvider', () => {
  test('生成包含 text 块的流式事件', async () => {
    const provider = createFauxProvider([{ content: [{ type: 'text', text: 'hello world' }] }])
    const { stream } = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    const events = await collectStream(stream)

    expect(events[0]!.type).toBe('response_start')
    const textStart = events.find((e) => e.type === 'chunk_start')!
    expect(textStart.type).toBe('chunk_start')
    const textDelta = events.find((e) => e.type === 'chunk_delta')!
    expect(textDelta.type).toBe('chunk_delta')
    if (textDelta.type === 'chunk_delta') {
      expect(textDelta.delta).toEqual({ type: 'text_delta', text: 'hello world' })
    }
    expect(events.at(-1)!.type).toBe('response_stop')
    expect(provider.calls).toBe(1)
    expect(provider.remaining).toBe(0)
  })

  test('生成包含 thinking 块的流式事件', async () => {
    const provider = createFauxProvider([
      {
        content: [
          { type: 'thinking', thinking: '让我想想...' },
          { type: 'text', text: '答案是 42' },
        ],
      },
    ])
    const { stream } = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    const events = await collectStream(stream)

    const thinkingDelta = events.find(
      (e) => e.type === 'chunk_delta' && e.delta.type === 'thinking_delta',
    )
    expect(thinkingDelta).toBeDefined()

    const textDelta = events.find((e) => e.type === 'chunk_delta' && e.delta.type === 'text_delta')
    expect(textDelta).toBeDefined()
  })

  test('生成包含 tool_call 块的流式事件', async () => {
    const provider = createFauxProvider([
      {
        content: [{ type: 'tool_call', name: 'Read', input: { file_path: '/tmp/test.txt' } }],
      },
    ])
    const { stream } = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    const events = await collectStream(stream)

    const toolStart = events.find(
      (e) => e.type === 'chunk_start' && 'chunk' in e && e.chunk.type === 'tool_call',
    )
    expect(toolStart).toBeDefined()

    const toolDelta = events.find(
      (e) => e.type === 'chunk_delta' && e.delta.type === 'input_json_delta',
    )
    expect(toolDelta).toBeDefined()
  })

  test('队列耗尽时抛错', async () => {
    const provider = createFauxProvider([])
    await expect(
      provider.createStream(
        { model: 'test', messages: [], maxTokens: 100 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('响应队列已耗尽')
  })

  test('多个预设响应按顺序消费', async () => {
    const provider = createFauxProvider([
      { content: [{ type: 'text', text: '第一轮' }] },
      { content: [{ type: 'text', text: '第二轮' }] },
    ])

    const r1 = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    await collectStream(r1.stream)
    expect(provider.calls).toBe(1)
    expect(provider.remaining).toBe(1)

    const r2 = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    await collectStream(r2.stream)
    expect(provider.calls).toBe(2)
    expect(provider.remaining).toBe(0)
  })

  test('自定义 stopReason 和 usage', async () => {
    const provider = createFauxProvider([
      {
        content: [{ type: 'text', text: 'tool call needed' }],
        stopReason: 'tool_use',
        usage: { inputTokens: 500, outputTokens: 200 },
      },
    ])
    const { stream } = await provider.createStream(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    const events = await collectStream(stream)

    const delta = events.find((e) => e.type === 'response_delta')!
    expect(delta.type).toBe('response_delta')
    if (delta.type === 'response_delta') {
      expect(delta.stopReason).toBe('tool_use')
      expect(delta.usage?.inputTokens).toBe(500)
      expect(delta.usage?.outputTokens).toBe(200)
    }
  })

  test('createMessage 返回 LLMResponse', async () => {
    const provider = createFauxProvider([{ content: [{ type: 'text', text: 'response' }] }])
    const result = await provider.createMessage(
      { model: 'test', messages: [], maxTokens: 100 },
      new AbortController().signal,
    )
    expect(result.model).toBe('test')
    expect(result.role).toBe('assistant')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0)
  })

  test('verifyApiKey 始终返回 true', async () => {
    const provider = createFauxProvider([])
    expect(await provider.verifyApiKey('any-key')).toBe(true)
  })
})
