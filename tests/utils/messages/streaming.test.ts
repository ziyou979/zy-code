import { describe, expect, test } from 'bun:test'
import {
  extractNormalizedThinkingLines,
  sliceLineWindowByWidth,
} from '../../../src/components/messages/CollapsedReadSearchContent.js'
import type { SpinnerMode } from '../../../src/components/Spinner.js'
import type { Message } from '../../../src/types/message.js'
import {
  handleMessageFromStream,
  type StreamingThinking,
  type StreamingToolUse,
} from '../../../src/services/messages/streaming.js'

function createHarness() {
  const modes: SpinnerMode[] = []
  const lengths: string[] = []
  let thinking: StreamingThinking | null = null
  let toolUses: StreamingToolUse[] = []

  const handle = (message: Message) =>
    handleMessageFromStream(
      message,
      () => {},
      (content) => lengths.push(content),
      (mode) => modes.push(mode),
      (update) => {
        toolUses = update(toolUses)
      },
      undefined,
      (update) => {
        thinking = update(thinking)
      },
      () => {},
    )

  return {
    get lengths() {
      return lengths
    },
    get modes() {
      return modes
    },
    get thinking() {
      return thinking
    },
    get toolUses() {
      return toolUses
    },
    handle,
  }
}

describe('handleMessageFromStream streaming thinking', () => {
  test('标准 chunk_delta 会实时累加 thinking 并在 text 块开始时结束', () => {
    const harness = createHarness()

    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 0,
        chunk: { type: 'thinking', thinking: '' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-delta-1',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '我在' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-delta-2',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思考' },
      },
    } as Message)

    expect(harness.modes).toContain('thinking')
    expect(harness.lengths).toEqual(['我在', '思考'])
    expect(harness.thinking).toMatchObject({
      thinking: '我在思考',
      isStreaming: true,
    })

    harness.handle({
      type: 'stream_event',
      uuid: 'text-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 1,
        chunk: { type: 'text', text: '' },
      },
    } as Message)

    expect(harness.modes.at(-1)).toBe('responding')
    expect(harness.thinking).toMatchObject({
      thinking: '我在思考',
      isStreaming: false,
    })
    expect(harness.thinking?.streamingEndedAt).toBeNumber()
  })

  test('工具块开始时也会结束实时 thinking', () => {
    const harness = createHarness()

    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 0,
        chunk: { type: 'thinking', thinking: '' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '先想清楚' },
      },
    } as Message)

    expect(harness.thinking).toMatchObject({
      thinking: '先想清楚',
      isStreaming: true,
    })

    harness.handle({
      type: 'stream_event',
      uuid: 'tool-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 1,
        chunk: {
          type: 'tool_call',
          id: 'call_1',
          name: 'Read',
          input: {},
        },
      },
    } as Message)

    expect(harness.modes.at(-1)).toBe('tool-input')
    expect(harness.thinking).toMatchObject({
      thinking: '先想清楚',
      isStreaming: false,
    })
    expect(harness.thinking?.streamingEndedAt).toBeNumber()
    expect(harness.toolUses).toHaveLength(1)
  })

  test('response_delta 会结束实时 thinking', () => {
    const harness = createHarness()

    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 0,
        chunk: { type: 'thinking', thinking: '' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'thinking-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '只思考' },
      },
    } as Message)

    harness.handle({
      type: 'stream_event',
      uuid: 'response-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'response_delta',
        delta: {},
      },
    } as Message)

    expect(harness.modes.at(-1)).toBe('responding')
    expect(harness.thinking).toMatchObject({
      thinking: '只思考',
      isStreaming: false,
    })
  })

  test('旧 content_block_delta 会实时累加 thinking', () => {
    const harness = createHarness()

    harness.handle({
      type: 'stream_event',
      uuid: 'old-thinking-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'old-thinking-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '旧流' },
      },
    } as Message)

    expect(harness.thinking).toMatchObject({
      thinking: '旧流',
      isStreaming: true,
    })
  })

  test('上一轮 thinking 结束后，新一轮 thinking_delta 会从头开始而不拼接旧段', () => {
    const harness = createHarness()

    harness.handle({
      type: 'stream_event',
      uuid: 't1-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '第一轮思考' },
      },
    } as Message)
    harness.handle({
      type: 'stream_event',
      uuid: 'tool-start',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_start',
        index: 1,
        chunk: { type: 'tool_call', id: 'call_1', name: 'Read', input: {} },
      },
    } as Message)

    expect(harness.thinking?.isStreaming).toBe(false)

    harness.handle({
      type: 'stream_event',
      uuid: 't2-delta',
      timestamp: new Date(0).toISOString(),
      event: {
        type: 'chunk_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '第二轮思考' },
      },
    } as Message)

    expect(harness.thinking).toMatchObject({
      thinking: '第二轮思考',
      isStreaming: true,
    })
  })
})

describe('CollapsedReadSearchContent 思考行换行更新与向左滚动窗口切片', () => {
  test('extractNormalizedThinkingLines 按换行提取非空行并清理 Markdown 前缀', () => {
    const raw = '# **第一行标题**\n\n- 第二行列表内容\n   \n第三行最新思考'
    expect(extractNormalizedThinkingLines(raw)).toEqual([
      '第一行标题',
      '第二行列表内容',
      '第三行最新思考',
    ])
  })

  test('sliceLineWindowByWidth 在超过最大宽度时支持向左滚动视窗', () => {
    const shortRes = sliceLineWindowByWidth('short text', 0, 20)
    expect(shortRes).toEqual({
      visibleText: 'short text',
      totalWidth: 10,
      maxStartCol: 0,
    })

    const longText = '0123456789abcdefghij0123456789'
    const startWindow = sliceLineWindowByWidth(longText, 0, 12)
    expect(startWindow.maxStartCol).toBe(18)
    expect(startWindow.visibleText).toBe('0123456789a…')

    const midWindow = sliceLineWindowByWidth(longText, 9, 12)
    expect(midWindow.visibleText).toBe('…abcdefghij…')

    const endWindow = sliceLineWindowByWidth(longText, 18, 12)
    expect(endWindow.visibleText).toBe('…j0123456789')
  })
})
