import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import type { RenderableMessage } from '../../src/types/message.js'
import { collapseReadSearchGroups } from '../../src/services/compact/collapseReadSearch.js'
import { createTestAssistantMessage } from '../_helpers/messageFixtures.js'

function thinking(uuid: string, text: string, timestamp: string): RenderableMessage {
  return createTestAssistantMessage([{ type: 'thinking', thinking: text }], {
    uuid,
    timestamp,
  })
}

function read(uuid: string, id: string, filePath: string, timestamp: string): RenderableMessage {
  return createTestAssistantMessage(
    [{ type: 'tool_call', id, name: 'Read', input: { file_path: filePath } }],
    { uuid, timestamp },
  )
}

function collapsedKinds(messages: RenderableMessage[]) {
  const group = collapsedGroup(messages)
  return {
    latestDisplayKind: group.latestDisplayKind,
    latestDisplayHint: group.latestDisplayHint,
    latestThinkingSummary: group.latestThinkingSummary,
  }
}

function collapsedGroup(messages: RenderableMessage[]) {
  const [group] = collapseReadSearchGroups(messages, [FileReadTool])
  expect(group?.type).toBe('collapsed_read_search')
  if (group?.type !== 'collapsed_read_search') {
    throw new Error('expected collapsed group')
  }
  return group
}

describe('collapseReadSearchGroups', () => {
  test('空思考签名不拆分连续读取，不把工具耗时估算成思考耗时', () => {
    const hidden = createTestAssistantMessage(
      [{ type: 'thinking', thinking: '', signature: '{"type":"reasoning"}' }],
      { uuid: 'hidden', timestamp: '2024-01-01T00:04:00.000Z' },
    )
    const result = collapseReadSearchGroups(
      [
        read('read-1', 'tool-1', 'src/current.ts', '2024-01-01T00:00:00.000Z'),
        hidden,
        read('read-2', 'tool-2', 'src/current.ts', '2024-01-01T00:04:01.000Z'),
        createTestAssistantMessage([{ type: 'thinking', thinking: '' }], {
          uuid: 'final-thinking',
          thinkingDurationMs: 36,
        }),
      ],
      [FileReadTool],
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'collapsed_read_search',
      readCount: 1,
      thinkingDurationMs: 36,
    })
    if (result[0]?.type === 'collapsed_read_search') {
      expect(result[0].messages).toContain(hidden)
      expect(result[0].thoughtForMs).toBeUndefined()
    }
  })

  test('工具后进入思考时，折叠提示切到思考摘要', () => {
    const result = collapsedKinds([
      read('read-1', 'tool-1', 'src/first.ts', '2024-01-01T00:00:00.000Z'),
      thinking('think-1', '分析新的调用结果', '2024-01-01T00:00:01.000Z'),
    ])

    expect(result.latestDisplayKind).toBe('thinking')
    expect(result.latestDisplayHint).toMatch(/^src[\\/]first\.ts$/)
    expect(result.latestThinkingSummary).toBe('分析新的调用结果')
  })

  test('思考后调用工具时，折叠提示切到工具明细', () => {
    const result = collapsedKinds([
      thinking('think-1', '先判断入口', '2024-01-01T00:00:00.000Z'),
      read('read-1', 'tool-1', 'src/current.ts', '2024-01-01T00:00:01.000Z'),
    ])

    expect(result.latestDisplayKind).toBe('tool')
    expect(result.latestDisplayHint).toMatch(/^src[\\/]current\.ts$/)
    expect(result.latestThinkingSummary).toBe('先判断入口')
  })

  test('显式 thinkingDurationMs 优先于 timestamp 估算时长', () => {
    const result = collapsedGroup([
      read('read-1', 'tool-1', 'src/current.ts', '2024-01-01T00:00:00.000Z'),
      createTestAssistantMessage([{ type: 'thinking', thinking: '显式计时更可信' }], {
        uuid: 'think-1',
        timestamp: '2024-01-01T00:00:07.000Z',
        thinkingDurationMs: 5000,
      }),
    ])

    expect(result.thoughtForMs).toBe(7000)
    expect(result.thinkingDurationMs).toBe(5000)
  })
})
