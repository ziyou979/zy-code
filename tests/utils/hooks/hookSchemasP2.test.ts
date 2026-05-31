/**
 * P2 schema 接受性：5.1 PostToolUse.duration_ms / 5.2 PostToolBatch / 5.3 UserPromptExpansion。
 * 纯 zod 解析。schema 图里有顶层 tSync→settings 的 TDZ，先全替换 i18n 再动态 import。
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'

// biome-ignore lint/suspicious/noExplicitAny: 动态导入的 schema 工厂
let S: any

beforeAll(async () => {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (k: string) => k,
    t: (k: string) => k,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  S = await import('../../../src/types/hooks/schemas.js')
})

const base = { session_id: 's', transcript_path: '/t', cwd: '/c' }

describe('P2 schema 接受性', () => {
  test('5.1 PostToolUse.duration_ms 被接受且可缺省', () => {
    expect(
      S.PostToolUseHookInputSchema().safeParse({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'tu1',
        duration_ms: 1234,
      }).success,
    ).toBe(true)
    // 缺省（向后兼容）
    expect(
      S.PostToolUseHookInputSchema().safeParse({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'tu1',
      }).success,
    ).toBe(true)
  })

  test('5.2 HOOK_EVENTS 含 PostToolBatch + 输入/输出 schema', () => {
    expect(S.HOOK_EVENTS).toContain('PostToolBatch')
    const r = S.PostToolBatchHookInputSchema().safeParse({
      ...base,
      hook_event_name: 'PostToolBatch',
      tool_uses: [
        { tool_name: 'Bash', tool_use_id: 't1', status: 'success' },
        { tool_name: 'Read', tool_use_id: 't2', status: 'error' },
      ],
    })
    expect(r.success).toBe(true)
    expect(
      S.PostToolBatchHookSpecificOutputSchema().safeParse({
        hookEventName: 'PostToolBatch',
        additionalContext: 'note',
      }).success,
    ).toBe(true)
    // status 仅允许 success|error
    expect(
      S.PostToolBatchHookInputSchema().safeParse({
        ...base,
        hook_event_name: 'PostToolBatch',
        tool_uses: [{ tool_name: 'Bash', tool_use_id: 't1', status: 'weird' }],
      }).success,
    ).toBe(false)
  })

  test('5.3 HOOK_EVENTS 含 UserPromptExpansion + 输入/输出 schema', () => {
    expect(S.HOOK_EVENTS).toContain('UserPromptExpansion')
    const r = S.UserPromptExpansionHookInputSchema().safeParse({
      ...base,
      hook_event_name: 'UserPromptExpansion',
      prompt: 'review @a.ts',
      expanded_text: 'review @a.ts\n<file a.ts contents...>',
    })
    expect(r.success).toBe(true)
    expect(
      S.UserPromptExpansionHookSpecificOutputSchema().safeParse({
        hookEventName: 'UserPromptExpansion',
        additionalContext: 'audit',
      }).success,
    ).toBe(true)
  })
})
