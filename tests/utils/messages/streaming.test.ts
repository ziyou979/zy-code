import { describe, expect, test } from 'bun:test'
import type { SpinnerMode } from '../../../src/components/Spinner.js'
import type { Message } from '../../../src/types/message.js'
import {
  handleMessageFromStream,
  type StreamingThinking,
  type StreamingToolUse,
} from '../../../src/services/messages/index.js'

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
})
