import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_RESUME_CONTEXT_PERCENT,
  DEFAULT_RESUME_THRESHOLD_MINUTES,
  getResumeReturnPrompt,
} from '../../../src/services/session-storage/resumeReturn.js'
import type { AssistantMessage } from '../../../src/types/message.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../../../src/services/context/modelContext.js'

const NOW = Date.parse('2026-07-10T12:00:00Z')

function makeAssistant(ageMinutes: number, tokens: number): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date(NOW - ageMinutes * 60_000).toISOString(),
    message: {
      role: 'assistant',
      id: 'message-1',
      model: 'test-model',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: tokens - 1, outputTokens: 1 },
    },
  }
}

describe('session-storage/resumeReturn', () => {
  afterEach(() => {
    delete process.env.ZY_CODE_RESUME_THRESHOLD_MINUTES
    delete process.env.ZY_CODE_RESUME_CONTEXT_PERCENT
  })

  test('会话同时超过默认时间和上下文占比阈值时提示摘要恢复', () => {
    const tokens = MODEL_CONTEXT_WINDOW_DEFAULT * (DEFAULT_RESUME_CONTEXT_PERCENT / 100) + 1
    const result = getResumeReturnPrompt(
      [makeAssistant(DEFAULT_RESUME_THRESHOLD_MINUTES + 1, tokens)],
      false,
      'test-model',
      NOW,
    )

    expect(result?.sessionAgeMinutes).toBe(DEFAULT_RESUME_THRESHOLD_MINUTES + 1)
    expect(result?.estimatedTokens).toBe(tokens)
    expect(result?.contextWindow).toBe(MODEL_CONTEXT_WINDOW_DEFAULT)
    expect(result?.contextUsagePercent).toBeGreaterThan(DEFAULT_RESUME_CONTEXT_PERCENT)
  })

  test('短时间恢复或用户已选择不再询问时不提示', () => {
    const messages = [makeAssistant(10, MODEL_CONTEXT_WINDOW_DEFAULT)]

    expect(getResumeReturnPrompt(messages, false, 'test-model', NOW)).toBeNull()
    expect(getResumeReturnPrompt(messages, true, 'test-model', NOW)).toBeNull()
  })

  test('支持通过环境变量调整两个阈值', () => {
    process.env.ZY_CODE_RESUME_THRESHOLD_MINUTES = '5'
    process.env.ZY_CODE_RESUME_CONTEXT_PERCENT = '40'

    expect(
      getResumeReturnPrompt(
        [makeAssistant(6, MODEL_CONTEXT_WINDOW_DEFAULT * 0.4)],
        false,
        'test-model',
        NOW,
      ),
    ).toEqual({
      sessionAgeMinutes: 6,
      estimatedTokens: MODEL_CONTEXT_WINDOW_DEFAULT * 0.4,
      contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
      contextUsagePercent: 40,
    })
  })

  test('已压缩会话：按 postTokens 估算，不因 keep 上旧 usage 误报 900k+', () => {
    process.env.ZY_CODE_RESUME_THRESHOLD_MINUTES = '5'
    process.env.ZY_CODE_RESUME_CONTEXT_PERCENT = '50'

    const boundary = {
      type: 'system' as const,
      subtype: 'compact_boundary' as const,
      content: 'Conversation compacted',
      isMeta: false as const,
      timestamp: new Date(NOW - 10 * 60_000).toISOString(),
      uuid: '00000000-0000-4000-8000-000000000099',
      level: 'info' as const,
      compactMetadata: {
        trigger: 'manual' as const,
        preTokens: 900_000,
        postTokens: 20_000,
        preservedSegment: {
          headUuid: '00000000-0000-4000-8000-000000000001',
          anchorUuid: '00000000-0000-4000-8000-000000000099',
          tailUuid: '00000000-0000-4000-8000-000000000001',
        },
      },
    }
    const keepWithStaleUsage = makeAssistant(120, 900_000)

    // 时间够长、若按 900k 会远超 50%，但真实热上下文只有 ~20k
    const result = getResumeReturnPrompt(
      [boundary as never, keepWithStaleUsage],
      false,
      'test-model',
      NOW,
    )
    expect(result).toBeNull()
  })
})
