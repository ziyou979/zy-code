import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import type { RenderableMessage } from '../../src/types/message.js'
import { collapseReadSearchGroups } from '../../src/utils/collapseReadSearch.js'
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
  const [group] = collapseReadSearchGroups(messages, [FileReadTool])
  expect(group?.type).toBe('collapsed_read_search')
  if (group?.type !== 'collapsed_read_search') {
    throw new Error('expected collapsed group')
  }
  return {
    latestDisplayKind: group.latestDisplayKind,
    latestDisplayHint: group.latestDisplayHint,
    latestThinkingSummary: group.latestThinkingSummary,
  }
}

describe('collapseReadSearchGroups', () => {
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
})
