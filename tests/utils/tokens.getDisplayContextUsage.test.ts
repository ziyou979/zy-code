/**
 * getDisplayContextUsage — 压缩后 statusline 上下文比例
 *
 * 复现用户问题：/compact 后旧 assistant.usage 仍在消息列表中（fullscreen 保留历史），
 * 直接 getCurrentUsage(fullMessages) 会读到压缩前的高用量，比例不变。
 */
import { describe, expect, test } from 'bun:test'
import { createCompactBoundaryMessage } from '../../src/utils/messages/constructors.js'
import { getCurrentUsage, getDisplayContextUsage } from '../../src/utils/tokens.js'
import { createTestAssistantMessage, createTestUserMessage } from '../_helpers/messageFixtures.js'

function makeAssistantWithUsage(
  inputTokens: number,
  opts: { uuid?: string; messageId?: string } = {},
) {
  const msg = createTestAssistantMessage([{ type: 'text', text: 'response' }], {
    uuid: opts.uuid ?? 'asst-usage',
    messageId: opts.messageId ?? 'msg-usage',
  })
  // 注入 API usage（getTokenUsage 读取 message.message.usage）
  // biome-ignore lint/suspicious/noExplicitAny: 测试注入 usage 字段
  ;(msg.message as any).usage = {
    inputTokens,
    outputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  return msg
}

describe('getDisplayContextUsage', () => {
  test('无 compact 时与 getCurrentUsage 一致', () => {
    const messages = [createTestUserMessage('hi'), makeAssistantWithUsage(50_000, { uuid: 'a1' })]
    expect(getDisplayContextUsage(messages)).toEqual(getCurrentUsage(messages))
    expect(getDisplayContextUsage(messages)?.inputTokens).toBe(50_000)
  })

  test('压缩后：忽略边界前旧 usage，使用 boundary.postTokens', () => {
    const preCompact = makeAssistantWithUsage(180_000, { uuid: 'pre-compact' })
    const boundary = createCompactBoundaryMessage('manual', 180_000)
    boundary.compactMetadata.postTokens = 12_000

    const summary = createTestUserMessage('This session is being continued… Summary: …', {
      uuid: 'summary',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    // 模拟 REPL：append 导致 [旧消息…, boundary, summary, …]
    const messages = [createTestUserMessage('old'), preCompact, boundary, summary]

    // 旧逻辑：仍看到 180k
    expect(getCurrentUsage(messages)?.inputTokens).toBe(180_000)

    // 新逻辑：statusline 应显示压缩后估算
    const display = getDisplayContextUsage(messages)
    expect(display).not.toBeNull()
    expect(display!.inputTokens).toBe(12_000)
    expect(display!.cacheReadInputTokens).toBe(0)
    expect(display!.outputTokens).toBe(0)
  })

  test('压缩后再有新 API 响应：优先用边界后 live usage', () => {
    const preCompact = makeAssistantWithUsage(180_000, { uuid: 'pre' })
    const boundary = createCompactBoundaryMessage('auto', 180_000)
    boundary.compactMetadata.postTokens = 12_000
    const summary = createTestUserMessage('summary', {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const postApi = makeAssistantWithUsage(15_500, {
      uuid: 'post-api',
      messageId: 'msg-post',
    })

    const messages = [preCompact, boundary, summary, createTestUserMessage('continue'), postApi]

    const display = getDisplayContextUsage(messages)
    expect(display?.inputTokens).toBe(15_500)
    // 不得回退到 pre 或 postTokens
    expect(display?.inputTokens).not.toBe(180_000)
    expect(display?.inputTokens).not.toBe(12_000)
  })

  test('有边界但无 postTokens 且无 live usage：返回 null（不跨边界读旧 usage）', () => {
    const preCompact = makeAssistantWithUsage(99_000, { uuid: 'pre' })
    const boundary = createCompactBoundaryMessage('manual', 99_000)
    // 故意不设 postTokens
    const summary = createTestUserMessage('summary', { isCompactSummary: true })

    const messages = [preCompact, boundary, summary]
    expect(getCurrentUsage(messages)?.inputTokens).toBe(99_000)
    expect(getDisplayContextUsage(messages)).toBeNull()
  })

  test('postTokens=0 视为无效，返回 null', () => {
    const preCompact = makeAssistantWithUsage(50_000)
    const boundary = createCompactBoundaryMessage('manual', 50_000)
    boundary.compactMetadata.postTokens = 0
    const messages = [preCompact, boundary]
    expect(getDisplayContextUsage(messages)).toBeNull()
  })

  test('空消息返回 null', () => {
    expect(getDisplayContextUsage([])).toBeNull()
  })
})
