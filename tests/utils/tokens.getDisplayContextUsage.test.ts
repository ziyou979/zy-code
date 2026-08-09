/**
 * getDisplayContextUsage — 压缩后 statusline 上下文比例
 *
 * 复现用户问题：/compact 后旧 assistant.usage 仍在消息列表中（fullscreen 保留历史），
 * 直接 getCurrentUsage(fullMessages) 会读到压缩前的高用量，比例不变。
 */
import { describe, expect, test } from 'bun:test'
import { createCompactBoundaryMessage } from '../../src/services/messages/constructors.js'
import type { Message } from '../../src/types/message.js'
import {
  getCurrentUsage,
  getDisplayContextUsage,
  tokenCountWithEstimation,
} from '../../src/services/api/tokens.js'
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

    // getCurrentUsage 仍会从任意列表末尾读到旧 usage；display 必须屏蔽
    expect(getCurrentUsage(messages)?.inputTokens).toBe(180_000)

    // 新逻辑：statusline 应显示压缩后估算
    const display = getDisplayContextUsage(messages)
    expect(display).not.toBeNull()
    expect(display!.inputTokens).toBe(12_000)
    expect(display!.cacheReadInputTokens).toBe(0)
    expect(display!.outputTokens).toBe(0)

    // 权威 token 计数同样不得锚定到 180k
    expect(tokenCountWithEstimation(messages)).toBeLessThan(50_000)
  })

  test('压缩后 keep 仍带旧 usage 时：不把它当 live，回退 postTokens', () => {
    const keep = makeAssistantWithUsage(900_000, {
      uuid: 'keep-old-usage',
      messageId: 'msg-keep',
    })
    const boundary = createCompactBoundaryMessage('auto', 900_000)
    boundary.compactMetadata.postTokens = 18_000
    boundary.compactMetadata.preservedSegment = {
      headUuid: keep.uuid,
      anchorUuid: boundary.uuid,
      tailUuid: keep.uuid,
    }
    const summary = createTestUserMessage('summary', {
      uuid: 'summary',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    // 典型 post-compact 热段：boundary + summary + keep
    const messages = [boundary, summary, keep]
    const display = getDisplayContextUsage(messages)
    expect(display?.inputTokens).toBe(18_000)
    expect(tokenCountWithEstimation(messages)).toBeLessThan(100_000)
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

  test('postTokens=0 视为无效：无 live 时返回 null', () => {
    const preCompact = makeAssistantWithUsage(50_000)
    const boundary = createCompactBoundaryMessage('manual', 50_000)
    boundary.compactMetadata.postTokens = 0
    const messages = [preCompact, boundary]
    expect(getDisplayContextUsage(messages)).toBeNull()
  })

  test('空消息返回 null', () => {
    expect(getDisplayContextUsage([])).toBeNull()
  })

  test('计划模式完整提醒参与估算时不会递归卡死', () => {
    const assistant = makeAssistantWithUsage(144_400, {
      uuid: 'plan-assistant',
      messageId: 'plan-response',
    })
    const planModeAttachment = {
      type: 'attachment',
      uuid: 'plan-mode-attachment',
      timestamp: '2026-07-14T00:00:00.000Z',
      attachment: {
        type: 'plan_mode',
        reminderType: 'full',
        planFilePath: 'C:\\tmp\\plan.md',
        planExists: false,
      },
    } as unknown as Message

    expect(tokenCountWithEstimation([assistant, planModeAttachment])).toBeGreaterThan(144_400)
  })
})
