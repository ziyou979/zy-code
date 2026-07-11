import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_RESUME_CONTEXT_PERCENT,
  DEFAULT_RESUME_THRESHOLD_MINUTES,
  getResumeReturnPrompt,
} from '../../../src/services/sessionStorage/resumeReturn.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../../../src/utils/context.js'
import type { AssistantMessage } from '../../../src/types/message.js'

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

describe('sessionStorage/resumeReturn', () => {
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
})
