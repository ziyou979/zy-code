import { describe, expect, test } from 'bun:test'
import { agentToolResultSchema } from '../../../src/services/agent/agentToolResultSchema.js'

describe('agentToolResultSchema', () => {
  // 基础成功结果（向后兼容）
  const baseResult = {
    agentId: 'test-agent-1',
    agentType: 'test',
    content: [{ type: 'text' as const, text: 'Task completed successfully' }],
    totalToolUseCount: 5,
    totalDurationMs: 10000,
    totalTokens: 500,
    usage: {
      inputTokens: 200,
      outputTokens: 300,
    },
  }

  test('basic success result passes validation', () => {
    const result = agentToolResultSchema().safeParse(baseResult)
    expect(result.success).toBe(true)
  })

  test('incomplete flag is optional (backward compat)', () => {
    const result = agentToolResultSchema().safeParse(baseResult)
    if (result.success) {
      expect(result.data.incomplete).toBeUndefined()
      expect(result.data.errorKind).toBeUndefined()
      expect(result.data.errorMessage).toBeUndefined()
    }
  })

  test('incomplete: true is valid', () => {
    const result = agentToolResultSchema().safeParse({
      ...baseResult,
      incomplete: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.incomplete).toBe(true)
    }
  })

  test('errorKind enum accepts all values', () => {
    const kinds = [
      'usage_limit',
      'rate_limited',
      'server_error',
      'stream_failure',
      'refusal',
      'internal',
    ] as const
    for (const kind of kinds) {
      const result = agentToolResultSchema().safeParse({
        ...baseResult,
        incomplete: true,
        errorKind: kind,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.errorKind).toBe(kind)
      }
    }
  })

  test('errorMessage with errorKind', () => {
    const result = agentToolResultSchema().safeParse({
      ...baseResult,
      incomplete: true,
      errorKind: 'usage_limit',
      errorMessage: 'This request would exceed your usage limit',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.errorKind).toBe('usage_limit')
      expect(result.data.errorMessage).toBe('This request would exceed your usage limit')
    }
  })

  test('invalid errorKind is rejected', () => {
    const result = agentToolResultSchema().safeParse({
      ...baseResult,
      errorKind: 'unknown_error',
    })
    expect(result.success).toBe(false)
  })

  test('incomplete: false is accepted', () => {
    const result = agentToolResultSchema().safeParse({
      ...baseResult,
      incomplete: false,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.incomplete).toBe(false)
    }
  })

  test('errorMessage without errorKind is valid', () => {
    const result = agentToolResultSchema().safeParse({
      ...baseResult,
      errorMessage: 'Something went wrong',
    })
    expect(result.success).toBe(true)
  })
})
