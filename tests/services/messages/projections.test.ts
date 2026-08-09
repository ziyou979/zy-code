import { describe, expect, test } from 'bun:test'
import { createCompactBoundaryMessage } from '../../../src/services/messages/constructors.js'
import {
  getDisplayMessages,
  getHotContextMessages,
  getLiveApiUsageMessages,
} from '../../../src/services/messages/projections.js'
import {
  createTestAssistantMessage,
  createTestUserMessage,
} from '../../_helpers/messageFixtures.js'

describe('message projections (display vs hot)', () => {
  test('getDisplayMessages 保留 boundary 前冷历史', () => {
    const cold = createTestUserMessage('old', { uuid: 'cold' })
    const boundary = createCompactBoundaryMessage('manual', 10_000)
    boundary.compactMetadata.postTokens = 1_000
    const hotUser = createTestUserMessage('after', { uuid: 'hot' })
    const messages = [cold, boundary, hotUser]

    const display = getDisplayMessages(messages)
    expect(display).toHaveLength(3)
    expect(display[0]?.uuid).toBe('cold')
    // 浅拷贝，不共享数组引用
    expect(display).not.toBe(messages)
  })

  test('getHotContextMessages 从 last boundary 起', () => {
    const cold = createTestUserMessage('old', { uuid: 'cold' })
    const boundary = createCompactBoundaryMessage('auto', 50_000)
    const hotUser = createTestUserMessage('after', { uuid: 'hot' })
    const messages = [cold, boundary, hotUser]

    const hot = getHotContextMessages(messages)
    expect(hot.map((m) => m.uuid)).toEqual([boundary.uuid, 'hot'])
  })

  test('getLiveApiUsageMessages 跳过 summary + preserved keep', () => {
    const keep = createTestAssistantMessage([{ type: 'text', text: 'kept' }], {
      uuid: 'keep-old',
      messageId: 'msg-keep',
    })
    const boundary = createCompactBoundaryMessage('auto', 90_000)
    boundary.compactMetadata.postTokens = 18_000
    boundary.compactMetadata.preservedSegment = {
      headUuid: keep.uuid,
      anchorUuid: boundary.uuid,
      tailUuid: keep.uuid,
    }
    const summary = createTestUserMessage('summary…', {
      uuid: 'summary',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const live = createTestAssistantMessage([{ type: 'text', text: 'new' }], {
      uuid: 'live',
      messageId: 'msg-live',
    })

    // boundary 必须在 keep 之前才会出现在 hot 切片中？
    // getMessagesAfterCompactBoundary 从 boundary 起，故 keep 需在 boundary 后才进 hot。
    const messages = [createTestUserMessage('pre'), boundary, summary, keep, live]
    const liveMsgs = getLiveApiUsageMessages(messages)
    expect(liveMsgs.map((m) => m.uuid)).toEqual(['live'])
  })

  test('无 boundary 时 hot === 全部', () => {
    const a = createTestUserMessage('a', { uuid: 'a' })
    const b = createTestUserMessage('b', { uuid: 'b' })
    expect(getHotContextMessages([a, b]).map((m) => m.uuid)).toEqual(['a', 'b'])
  })
})
