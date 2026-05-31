/**
 * P1 PR-A schema 接受性：4.2 updatedToolOutput / 4.5 terminalSequence /
 * 4.3 background_tasks+session_crons / 4.4 args exec form。
 *
 * 纯 zod schema 解析。schema 导入图里有模块顶层调用 tSync（zyAiLimits 等）会触发
 * settings.ts 循环初始化 TDZ，故先全替换 i18n，再动态 import schema。
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'

// biome-ignore lint/suspicious/noExplicitAny: 测试持有动态导入的 schema 工厂
let S: any
// biome-ignore lint/suspicious/noExplicitAny: 同上
let HookCommandSchema: any

beforeAll(async () => {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (k: string) => k,
    t: (k: string) => k,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  S = await import('../../../src/types/hooks/schemas.js')
  ;({ HookCommandSchema } = await import('../../../src/schemas/hooks.js'))
})

const baseInput = {
  session_id: 's1',
  transcript_path: '/t',
  cwd: '/cwd',
}

describe('PR-A schema 接受性', () => {
  test('4.2 PostToolUse.updatedToolOutput 被接受', () => {
    const r = S.PostToolUseHookSpecificOutputSchema().safeParse({
      hookEventName: 'PostToolUse',
      updatedToolOutput: 'overridden result',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.updatedToolOutput).toBe('overridden result')
    }
  })

  test('4.5 SyncHookJSONOutput.terminalSequence 被接受', () => {
    const r = S.SyncHookJSONOutputSchema().safeParse({ terminalSequence: '\x07' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.terminalSequence).toBe('\x07')
    }
  })

  test('4.3 Stop.background_tasks + session_crons 被接受', () => {
    const r = S.StopHookInputSchema().safeParse({
      ...baseInput,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      background_tasks: [
        { id: 't1', type: 'local_bash', status: 'running', description: 'npm test' },
      ],
      session_crons: [
        { id: 'c1', schedule: '0 9 * * *', recurring: true, next_run: '2026-06-01T09:00:00.000Z' },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('4.3 SubagentStop 同样接受两字段', () => {
    const r = S.SubagentStopHookInputSchema().safeParse({
      ...baseInput,
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'a1',
      agent_transcript_path: '/at',
      agent_type: 'general-purpose',
      background_tasks: [
        { id: 't1', type: 'local_agent', status: 'running', description: 'subtask' },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('4.3 两字段可缺省（向后兼容老 hook）', () => {
    const r = S.StopHookInputSchema().safeParse({
      ...baseInput,
      hook_event_name: 'Stop',
      stop_hook_active: true,
    })
    expect(r.success).toBe(true)
  })

  test('4.4 command hook 接受 exec form 的 args', () => {
    const r = HookCommandSchema().safeParse({
      type: 'command',
      command: '/usr/bin/echo',
      args: ['foo', 'bar baz.txt'],
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.type === 'command') {
      expect(r.data.args).toEqual(['foo', 'bar baz.txt'])
    }
  })

  test('4.4 shell form（无 args）仍被接受', () => {
    const r = HookCommandSchema().safeParse({ type: 'command', command: 'echo hi' })
    expect(r.success).toBe(true)
  })
})
