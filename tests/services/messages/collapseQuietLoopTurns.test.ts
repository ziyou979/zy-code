import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { collapseQuietLoopTurns } from '../../../src/services/messages/collapseQuietLoopTurns.js'
import { normalizeMessages } from '../../../src/services/messages/normalize.js'
import { buildTool } from '../../../src/tools/tool.js'
import type { Message } from '../../../src/types/message.js'
import {
  createTestAssistantMessage,
  createTestUserMessage,
} from '../../_helpers/messageFixtures.js'

function observationTool(name: string, readOnly: boolean) {
  return buildTool({
    name,
    inputSchema: z.object({}),
    maxResultSizeChars: 100,
    isReadOnly: () => readOnly,
    async call() {
      return { data: 'test' }
    },
    async description() {
      return 'test'
    },
    async prompt() {
      return 'test'
    },
    mapToolResultToToolResultBlock(content: string, toolCallId: string) {
      return { type: 'tool_result' as const, content, toolCallId }
    },
    renderToolUseMessage() {
      return null
    },
  })
}
const tools = [observationTool('Read', true), observationTool('Write', false)]
const objective = '<<autonomous-loop-dynamic>>\nWatch build'

function turn(
  id: string,
  options: { noop?: boolean; error?: boolean; tool?: string; prompt?: string; stop?: boolean } = {},
): Message[] {
  const prompt = options.prompt ?? objective
  return [
    {
      type: 'system',
      subtype: 'scheduled_task_fire',
      content: 'scheduled',
      uuid: `${id}-fire`,
      timestamp: '2026-09-19T00:00:00Z',
    },
    createTestUserMessage([{ type: 'text', text: prompt }], { uuid: `${id}-prompt`, isMeta: true }),
    createTestAssistantMessage(
      [{ type: 'tool_call', id: `${id}-read`, name: options.tool ?? 'Read', input: {} }],
      { uuid: `${id}-call` },
    ),
    createTestUserMessage(
      [
        {
          type: 'tool_result',
          toolCallId: `${id}-read`,
          content: 'unchanged',
          isError: options.error,
        },
      ],
      { uuid: `${id}-read-result` },
    ),
    createTestAssistantMessage(
      [
        {
          type: 'tool_call',
          id: `${id}-schedule`,
          name: 'ScheduleWakeup',
          input: {
            prompt,
            noop: options.noop ?? true,
            stop: options.stop,
            delaySeconds: 1200,
            reason: 'wait',
          },
        },
      ],
      { uuid: `${id}-schedule-call` },
    ),
    createTestUserMessage(
      [{ type: 'tool_result', toolCallId: `${id}-schedule`, content: 'scheduled' }],
      { uuid: `${id}-schedule-result` },
    ),
  ]
}

describe('collapseQuietLoopTurns', () => {
  test('连续空轮次合并且不修改原始记录，恢复后可重建相同结果', () => {
    const messages = [...turn('one'), ...turn('two')]
    const original = JSON.stringify(messages)
    const collapsed = collapseQuietLoopTurns(messages, tools, true)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]).toMatchObject({
      type: 'system',
      subtype: 'quiet_loop',
      uuid: 'one-fire-quiet-loop',
    })
    expect(JSON.stringify(collapsed)).toContain('2')
    expect(JSON.stringify(messages)).toBe(original)
    expect(collapseQuietLoopTurns(JSON.parse(original), tools, true)).toEqual(collapsed)
    expect(collapseQuietLoopTurns(normalizeMessages(messages), tools, true)).toEqual(collapsed)
  })

  test('完整记录模式原样返回', () => {
    const messages = turn('one')
    expect(collapseQuietLoopTurns(messages, tools, false)).toBe(messages)
  })

  for (const [label, options] of [
    ['检查失败', { error: true }],
    ['有进展', { noop: false }],
    ['写操作', { tool: 'Write' }],
    ['未知工具', { tool: 'Unknown' }],
    ['停止循环', { stop: true }],
  ] as const) {
    test(`${label}保留原始消息`, () => {
      const messages = turn('one', options)
      expect(collapseQuietLoopTurns(messages, tools, true)).toEqual(messages)
    })
  }

  test('未收到调度结果时不折叠', () => {
    const messages = turn('one').slice(0, -1)
    expect(collapseQuietLoopTurns(messages, tools, true)).toEqual(messages)
  })

  test('观察工具转后台尚未完成时不折叠', () => {
    const messages = turn('one')
    const result = messages[3]!
    if (result.type === 'user') {
      result.toolUseResult = { backgroundTaskId: 'pending-observation' }
    }
    expect(collapseQuietLoopTurns(messages, tools, true)).toEqual(messages)
  })

  test('用户插话、通知、目标变化都终止连续计数', () => {
    const human = createTestUserMessage([{ type: 'text', text: 'status?' }])
    const messages = [
      ...turn('one'),
      human,
      ...turn('two'),
      ...turn('three', { prompt: `${objective} B` }),
    ]
    const result = collapseQuietLoopTurns(messages, tools, true)
    expect(result).toHaveLength(4)
    expect(result[1]).toBe(human)
    const notification = createTestUserMessage([{ type: 'text', text: 'Build failed' }], {
      isMeta: true,
    })
    expect(
      collapseQuietLoopTurns([...turn('one'), notification, ...turn('two')], tools, true),
    ).toHaveLength(3)
  })

  test('保留模型报告正文和 API 错误，不信任错误的 noop 声明', () => {
    const report = createTestAssistantMessage([{ type: 'text', text: 'Build failed' }])
    const messages = [...turn('one'), report]
    expect(collapseQuietLoopTurns(messages, tools, true)).toEqual(messages)
    const failed = [...turn('one'), createTestAssistantMessage([], { isApiErrorMessage: true })]
    expect(collapseQuietLoopTurns(failed, tools, true)).toEqual(failed)
  })

  test('人类粘贴相同标记不会被当成自动唤醒', () => {
    const messages = turn('one')
    const prompt = messages[1]!
    if (prompt.type === 'user') {
      prompt.isMeta = false
    }
    expect(collapseQuietLoopTurns(messages, tools, true)).toEqual(messages)
  })
})
