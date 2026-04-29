/**
 * 入站测试：OpenAI 流式响应 → 标准 StreamEvent
 * 被测函数：streamAdapter.ts mapOpenAIStreamToStandard
 *
 * 重点关注：
 * - 各种事件类型组合下的 chunk_start / chunk_delta / chunk_stop 顺序
 * - 工具调用 index 必须正确分配，不能与 thinking / text block 撞 index
 * - reasoning_content 走独立 thinking block
 * - finish_reason → stopReason 映射
 * - usage 透传
 */
import { describe, test, expect } from 'bun:test'
import { mapOpenAIStreamToStandard } from '../../../src/services/api/conversions/openai.js'
import {
  textChunk,
  reasoningChunk,
  toolCallStartChunk,
  toolCallArgFragmentChunk,
  finishChunk,
  chunksToStream,
} from '../../_helpers/openaiStreamFixtures.js'
import type { StreamEvent } from '../../../src/types/llm.js'

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('mapOpenAIStreamToStandard: 入站 OpenAI 流式映射', () => {
  test('纯文本流：response_start → chunk_start(text) → chunk_delta(text_delta)+ → chunk_stop → response_delta → response_stop', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          textChunk('Hello '),
          textChunk('world'),
          finishChunk({ finishReason: 'stop' }),
        ]),
        'gpt-4',
      ),
    )
    const types = events.map(e => e.type)
    expect(types[0]).toBe('response_start')
    expect(types[1]).toBe('chunk_start')
    expect(types).toContain('chunk_delta')
    expect(types).toContain('chunk_stop')
    expect(types).toContain('response_delta')
    expect(types[types.length - 1]).toBe('response_stop')

    const start = events[1] as any
    expect(start.chunk).toEqual({ type: 'text', text: '' })

    const deltas = events.filter(e => e.type === 'chunk_delta') as any[]
    expect(deltas.map(d => d.delta.text).join('')).toBe('Hello world')

    const respDelta = events.find(e => e.type === 'response_delta') as any
    expect(respDelta.stopReason).toBe('end_turn')
  })

  test('单工具调用，arguments 一次性到达：chunk type 必须是 tool_call', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          toolCallStartChunk({
            index: 0,
            id: 'call_abc',
            name: 'search',
            argumentsFragment: '{"q":"hi"}',
          }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'gpt-4',
      ),
    )
    const start = events.find(e => e.type === 'chunk_start') as any
    expect(start.chunk).toEqual({
      type: 'tool_call',
      id: 'call_abc',
      name: 'search',
      input: {},
    })
    const delta = events.find(e => e.type === 'chunk_delta') as any
    expect(delta.delta).toEqual({
      type: 'input_json_delta',
      partialJson: '{"q":"hi"}',
    })
    const respDelta = events.find(e => e.type === 'response_delta') as any
    expect(respDelta.stopReason).toBe('tool_use')
  })

  test('单工具调用，arguments 分多片：每片一个 input_json_delta', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          toolCallStartChunk({
            index: 0,
            id: 'c',
            name: 'f',
            argumentsFragment: '{"q":',
          }),
          toolCallArgFragmentChunk({ index: 0, argumentsFragment: '"hello"' }),
          toolCallArgFragmentChunk({ index: 0, argumentsFragment: '}' }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'gpt-4',
      ),
    )
    const fragments = events
      .filter(e => e.type === 'chunk_delta')
      .map((e: any) => e.delta.partialJson)
    expect(fragments.join('')).toBe('{"q":"hello"}')
  })

  test('多工具调用并行：每个 tool_call 都独立 chunk_start，index 不冲突', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          toolCallStartChunk({
            index: 0, id: 'a', name: 'fa', argumentsFragment: '{"x":1}',
          }),
          toolCallStartChunk({
            index: 1, id: 'b', name: 'fb', argumentsFragment: '{"y":2}',
          }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'gpt-4',
      ),
    )
    const starts = events.filter(e => e.type === 'chunk_start') as any[]
    expect(starts).toHaveLength(2)
    const indices = starts.map(s => s.index)
    expect(new Set(indices).size).toBe(2)
    expect(starts[0].chunk.id).toBe('a')
    expect(starts[1].chunk.id).toBe('b')
  })

  test('text + tool_call：tool_call 的 index 必须 > text 的 index，避免撞车', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          textChunk('I will call a tool. '),
          toolCallStartChunk({
            index: 0, id: 'c', name: 'f', argumentsFragment: '{}',
          }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'gpt-4',
      ),
    )
    const starts = events.filter(e => e.type === 'chunk_start') as any[]
    expect(starts).toHaveLength(2)
    const textStart = starts.find(s => s.chunk.type === 'text')
    const toolStart = starts.find(s => s.chunk.type === 'tool_call')
    expect(textStart!.index).toBeLessThan(toolStart!.index)
  })

  test('reasoning_content + tool_call：thinking 在前，tool_call index 必须 > thinking index', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          reasoningChunk('let me think...'),
          reasoningChunk(' more...'),
          toolCallStartChunk({
            index: 0, id: 'c', name: 'f', argumentsFragment: '{"a":1}',
          }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'qwen-plus',
      ),
    )
    const starts = events.filter(e => e.type === 'chunk_start') as any[]
    expect(starts).toHaveLength(2)
    const thinkStart = starts.find(s => s.chunk.type === 'thinking')
    const toolStart = starts.find(s => s.chunk.type === 'tool_call')
    expect(thinkStart).toBeDefined()
    expect(toolStart).toBeDefined()
    expect(thinkStart!.index).toBeLessThan(toolStart!.index)
    // thinking_delta 必须挂在 thinking 那个 index
    const thinkingDeltas = events.filter(
      (e: any) => e.type === 'chunk_delta' && e.delta.type === 'thinking_delta',
    ) as any[]
    expect(thinkingDeltas.every(d => d.index === thinkStart!.index)).toBe(true)
    // input_json_delta 必须挂在 tool 那个 index
    const inputDeltas = events.filter(
      (e: any) => e.type === 'chunk_delta' && e.delta.type === 'input_json_delta',
    ) as any[]
    expect(inputDeltas.every(d => d.index === toolStart!.index)).toBe(true)
  })

  test('thinking + text + tool_call：三种 block 的 index 都互不冲突', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          reasoningChunk('think'),
          textChunk('answer '),
          toolCallStartChunk({
            index: 0, id: 'c', name: 'f', argumentsFragment: '{}',
          }),
          finishChunk({ finishReason: 'tool_calls' }),
        ]),
        'qwen-plus',
      ),
    )
    const starts = events.filter(e => e.type === 'chunk_start') as any[]
    const idxByType = new Map<string, number>()
    for (const s of starts) idxByType.set(s.chunk.type, s.index)
    expect(idxByType.get('thinking')).toBe(0)
    expect(idxByType.get('text')).toBe(1)
    expect(idxByType.get('tool_call')).toBe(2)
  })

  test('finish_reason 映射全部分支', async () => {
    const cases: Array<['stop' | 'tool_calls' | 'length' | 'content_filter', string]> = [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'content_filter'],
    ]
    for (const [finish, expected] of cases) {
      const events = await collect(
        mapOpenAIStreamToStandard(
          chunksToStream([textChunk('hi'), finishChunk({ finishReason: finish })]),
          'gpt-4',
        ),
      )
      const respDelta = events.find(e => e.type === 'response_delta') as any
      // respDelta.stopReason 是 StopReason union，但用 as any 已经丢类型；这里直接字符串比较即可
      expect(respDelta.stopReason as string).toBe(expected)
    }
  })

  test('usage 透传到 response_delta.usage.outputTokens', async () => {
    const events = await collect(
      mapOpenAIStreamToStandard(
        chunksToStream([
          textChunk('hi'),
          finishChunk({
            finishReason: 'stop',
            promptTokens: 10,
            completionTokens: 7,
          }),
        ]),
        'gpt-4',
      ),
    )
    const respDelta = events.find(e => e.type === 'response_delta') as any
    expect(respDelta.usage.outputTokens).toBe(7)
  })
})
