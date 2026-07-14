/**
 * statusline context 模块：压缩后比例应反映 postTokens，而非压缩前 usage
 */
import { describe, expect, test } from 'bun:test'
import {
  renderStatusbarSegments,
  type StatusbarContext,
} from '../../../src/components/statusbar/renderSegments.js'
import type { ModuleConfig } from '../../../src/components/statusbar/statusbarModuleDefaults.js'
import { createCompactBoundaryMessage } from '../../../src/services/messages/constructors.js'
import {
  createTestAssistantMessage,
  createTestUserMessage,
} from '../../_helpers/messageFixtures.js'

function makeAssistantWithUsage(inputTokens: number) {
  const msg = createTestAssistantMessage([{ type: 'text', text: 'ok' }], {
    uuid: 'asst-pre',
    messageId: 'msg-pre',
  })
  // biome-ignore lint/suspicious/noExplicitAny: 测试注入 usage
  ;(msg.message as any).usage = {
    inputTokens,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  return msg
}

function baseCtx(messages: StatusbarContext['messages']): StatusbarContext {
  return {
    messages,
    mainLoopModel: 'claude-sonnet-4-5' as never,
    effortValue: undefined,
    thinkingEnabled: false,
    branch: null,
    gitClean: null,
    memoryRss: 0,
  }
}

const contextModule: ModuleConfig = {
  id: 'context',
  visible: true,
  icon: '',
  color: 'text',
}

describe('statusline context after compact', () => {
  test('压缩后 context 段使用 postTokens，不再显示压缩前高用量', () => {
    const pre = makeAssistantWithUsage(160_000)
    const boundary = createCompactBoundaryMessage('manual', 160_000)
    boundary.compactMetadata.postTokens = 8_000
    const summary = createTestUserMessage('compact summary', {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const messages = [createTestUserMessage('old task'), pre, boundary, summary]

    const segs = renderStatusbarSegments([contextModule], baseCtx(messages))
    expect(segs.length).toBe(1)
    const text = segs[0]!.text

    // 应体现 ~8k 用量，而不是 160k
    expect(text).toMatch(/8\.?0?k|8000/i)
    // 百分比应显著低于压缩前 ~80%+（8k/200k ≈ 4%）
    expect(text).toMatch(/\b[0-9]%/)
    // 不应再显示接近满窗的高百分比
    expect(text).not.toMatch(/\b(7[5-9]|8\d|9\d|100)%/)
  })

  test('压缩后再有 live usage 时优先 live', () => {
    const pre = makeAssistantWithUsage(160_000)
    const boundary = createCompactBoundaryMessage('manual', 160_000)
    boundary.compactMetadata.postTokens = 8_000
    const post = makeAssistantWithUsage(20_000)
    post.uuid = 'asst-post'
    // biome-ignore lint/suspicious/noExplicitAny: 测试
    ;(post.message as any).id = 'msg-post'

    const messages = [pre, boundary, createTestUserMessage('next'), post]
    const segs = renderStatusbarSegments([contextModule], baseCtx(messages))
    const text = segs[0]!.text
    expect(text).toMatch(/20\.?0?k|20000/i)
  })
})
