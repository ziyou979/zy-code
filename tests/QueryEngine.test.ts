// QueryEngine.submitMessage 主循环 switch 的 characterization 测试。
//
// 目的：锁定「switch 按 message.type 分发」各分支的可观察行为（产出的
// WireMessage 序列 / 终态 result），作为把 switch(messageType:string) 重构成
// switch(message.type) 的安全网——重构前后这批断言都必须通过。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import type { Message } from '../src/types/message.js'
import { installQueryEngineMocks, runEngine } from './_helpers/queryEngineHarness.js'

const TS = '2024-01-01T00:00:00.000Z'

function assistant(text: string, uuid = 'a1'): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: TS,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      id: `msg_${uuid}`,
      model: 'claude-test',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  } as unknown as Message
}

function userToolResult(uuid = 'u1'): Message {
  return {
    type: 'user',
    uuid,
    timestamp: TS,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 'tc1', content: 'ok', isError: false }],
    },
  } as unknown as Message
}

function attachment(payload: Record<string, unknown>, uuid = 'att1'): Message {
  return {
    type: 'attachment',
    uuid,
    timestamp: TS,
    attachment: payload,
  } as unknown as Message
}

function streamEvent(event: Record<string, unknown>, uuid: string): Message {
  return { type: 'stream_event', uuid, timestamp: TS, event } as unknown as Message
}

describe('QueryEngine.submitMessage switch 分发', () => {
  beforeEach(async () => {
    await installQueryEngineMocks()
  })
  afterEach(() => mock.restore())

  test('assistant：产出 assistant 消息并以 success 收尾，捕获 stop_reason', async () => {
    const { wire, result } = await runEngine([assistant('hello world')])

    const asst = wire.filter((m) => m.type === 'assistant')
    expect(asst.length).toBe(1)
    expect(result?.type).toBe('result')
    expect(result?.subtype).toBe('success')
    expect((result as { result: string }).result).toBe('hello world')
    expect((result as { stop_reason: string }).stop_reason).toBe('end_turn')
  })

  test('progress：被记入 getMessages 且不影响 success 收尾', async () => {
    const progress = {
      type: 'progress',
      uuid: 'p1',
      timestamp: TS,
      toolUseID: 'tu1',
      parentToolUseID: 'ptu1',
      data: { type: 'noop_progress' },
    } as unknown as Message

    const { result, engine } = await runEngine([progress, assistant('done')])

    expect(result?.subtype).toBe('success')
    expect(engine.getMessages().some((m) => m.uuid === 'p1')).toBe(true)
  })

  test('user：产出 user 消息且 num_turns 递增', async () => {
    const { wire, result } = await runEngine([userToolResult('u1'), assistant('after tool')])

    expect(wire.some((m) => m.type === 'user')).toBe(true)
    // turnCount 起始 1，遇到一条 user 消息 +1
    expect((result as { num_turns: number }).num_turns).toBe(2)
  })

  test('stream_event：includePartialMessages 时透传，并从 delta 捕获 stop_reason', async () => {
    const { wire, result } = await runEngine(
      [
        streamEvent({ type: 'message_start', message: { usage: { inputTokens: 10 } } }, 's1'),
        streamEvent(
          { type: 'message_delta', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' },
          's2',
        ),
        streamEvent({ type: 'message_stop' }, 's3'),
        assistant('streamed'),
      ],
      { config: { includePartialMessages: true } },
    )

    expect(wire.filter((m) => m.type === 'stream_event').length).toBe(3)
    expect(result?.subtype).toBe('success')
    expect((result as { stop_reason: string }).stop_reason).toBe('end_turn')
    expect((result as { usage: unknown }).usage).toBeDefined()
  })

  test('attachment structured_output：data 进入终态 result.structured_output', async () => {
    const { result } = await runEngine([
      attachment({ type: 'structured_output', data: { foo: 'bar' } }),
      assistant('done'),
    ])

    expect(result?.subtype).toBe('success')
    expect((result as { structured_output: unknown }).structured_output).toEqual({ foo: 'bar' })
  })

  test('attachment max_turns_reached：产出 error_max_turns，num_turns 与 maxTurns 正确', async () => {
    const { result } = await runEngine([
      attachment({ type: 'max_turns_reached', maxTurns: 5, turnCount: 3 }),
    ])

    expect(result?.subtype).toBe('error_max_turns')
    expect((result as { isError: boolean }).isError).toBe(true)
    expect((result as { num_turns: number }).num_turns).toBe(3)
    expect((result as { errors: string[] }).errors[0]).toContain('5')
  })

  test('attachment queued_command：replayUserMessages 时回放 user 消息', async () => {
    const { wire } = await runEngine(
      [
        attachment(
          {
            type: 'queued_command',
            prompt: [{ type: 'text', text: 'queued prompt' }],
            source_uuid: 'src-uuid',
          },
          'att-q',
        ),
        assistant('done'),
      ],
      { config: { replayUserMessages: true } },
    )

    const replay = wire.find((m) => m.type === 'user' && (m as { uuid: string }).uuid === 'src-uuid')
    expect(replay).toBeDefined()
    expect((replay as { isReplay: boolean }).isReplay).toBe(true)
    expect((replay as { message: { content: unknown } }).message.content).toEqual([
      { type: 'text', text: 'queued prompt' },
    ])
  })

  test('system api_error：产出 api_retry 且字段映射正确', async () => {
    const apiError = {
      type: 'system',
      subtype: 'api_error',
      uuid: 'e1',
      timestamp: TS,
      level: 'error',
      error: { status: 500, message: 'boom' },
      retryAttempt: 1,
      maxRetries: 3,
      retryInMs: 1000,
    } as unknown as Message

    const { wire } = await runEngine([apiError, assistant('recovered')])

    const retry = wire.find((m) => m.type === 'system' && (m as { subtype: string }).subtype === 'api_retry')
    expect(retry).toBeDefined()
    expect((retry as { attempt: number }).attempt).toBe(1)
    expect((retry as { max_retries: number }).max_retries).toBe(3)
    expect((retry as { retry_delay_ms: number }).retry_delay_ms).toBe(1000)
    expect((retry as { error_status: number }).error_status).toBe(500)
  })

  test('system compact_boundary：产出 compact_boundary WireMessage', async () => {
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'cb1',
      timestamp: TS,
      content: '',
      compactMetadata: { trigger: 'manual', preTokens: 100 },
    } as unknown as Message

    const { wire } = await runEngine([assistant('before', 'a0'), boundary, assistant('after', 'a2')])

    const cb = wire.find(
      (m) => m.type === 'system' && (m as { subtype: string }).subtype === 'compact_boundary',
    )
    expect(cb).toBeDefined()
    expect((cb as { uuid: string }).uuid).toBe('cb1')
  })

  test('tool_use_summary：产出 tool_use_summary WireMessage', async () => {
    const summary = {
      type: 'tool_use_summary',
      uuid: 'tus1',
      timestamp: TS,
      summary: 'did stuff',
      precedingToolUseIds: ['x', 'y'],
    } as unknown as Message

    const { wire } = await runEngine([summary, assistant('done')])

    const tus = wire.find((m) => m.type === 'tool_use_summary')
    expect(tus).toBeDefined()
    expect((tus as { summary: string }).summary).toBe('did stuff')
    expect((tus as { preceding_tool_use_ids: string[] }).preceding_tool_use_ids).toEqual(['x', 'y'])
  })

  test('tombstone（type=system, subtype=tombstone）：不产出额外 WireMessage，但被记入 getMessages', async () => {
    const tombstone = {
      type: 'system',
      subtype: 'tombstone',
      uuid: 'tomb1',
      timestamp: TS,
      content: '',
      message: assistant('ghost', 'ghost'),
    } as unknown as Message

    const { wire, engine, result } = await runEngine([tombstone, assistant('alive', 'a2')])

    // tombstone 不应衍生任何 system WireMessage（忽略首条 init）
    expect(
      wire.some((m) => m.type === 'system' && (m as { subtype: string }).subtype !== 'init'),
    ).toBe(false)
    expect(engine.getMessages().some((m) => m.uuid === 'tomb1')).toBe(true)
    expect(result?.subtype).toBe('success')
  })

  test('maxBudgetUsd 超限：产出 error_max_budget_usd', async () => {
    const { result } = await runEngine([assistant('hi')], { config: { maxBudgetUsd: 0 } })

    expect(result?.subtype).toBe('error_max_budget_usd')
    expect((result as { isError: boolean }).isError).toBe(true)
  })

  test('结构化输出重试超限：产出 error_max_structured_output_retries', async () => {
    const prev = process.env.MAX_STRUCTURED_OUTPUT_RETRIES
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '0'
    try {
      const { result } = await runEngine([userToolResult('u1')], {
        config: { jsonSchema: { type: 'object' } },
      })
      expect(result?.subtype).toBe('error_max_structured_output_retries')
    } finally {
      if (prev === undefined) {
        delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
      } else {
        process.env.MAX_STRUCTURED_OUTPUT_RETRIES = prev
      }
    }
  })
})
