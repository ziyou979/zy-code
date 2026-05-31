/**
 * 5.2 executePostToolBatchHooks —— gate 短路 + 输出转换（additionalContext / preventContinuation
 * → 消息），供 query.ts 按 toolUpdates 方式消费。mock executeHooks + hasHookForEvent。
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// executeHooks 可控产出 + gate
let QUEUED: Array<Record<string, unknown>> = []
let HAS_HOOK = true

// biome-ignore lint/suspicious/noExplicitAny: 动态导入
let executePostToolBatchHooks: any

beforeAll(async () => {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (k: string) => k,
    t: (k: string) => k,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  mock.module('../../../src/utils/hooks/executeEngine.js', () => ({
    executeHooks: async function* () {
      for (const r of QUEUED) {
        yield r
      }
    },
  }))
  const matcher = await import('../../../src/utils/hooks/matcher.js')
  mock.module('../../../src/utils/hooks/matcher.js', () => ({
    ...matcher,
    hasHookForEvent: () => HAS_HOOK,
  }))
  ;({ executePostToolBatchHooks } = await import('../../../src/utils/hooks/executors/tool.js'))
})

const ctx = {
  getAppState: () => ({}),
  abortController: { signal: undefined },
} as any
const toolUses = [{ tool_name: 'Bash', tool_use_id: 't1', status: 'success' as const }]

async function collect(): Promise<any[]> {
  const out: any[] = []
  for await (const u of executePostToolBatchHooks(toolUses, ctx)) {
    out.push(u)
  }
  return out
}

describe('5.2 executePostToolBatchHooks', () => {
  beforeEach(() => {
    QUEUED = []
    HAS_HOOK = true
  })

  test('未配置 PostToolBatch hook → 不产出（gate 短路）', async () => {
    HAS_HOOK = false
    QUEUED = [{ additionalContexts: ['x'] }]
    expect(await collect()).toEqual([])
  })

  test('hook 输出消息原样透传', async () => {
    const msg = { type: 'attachment', attachment: { type: 'hook_success' } }
    QUEUED = [{ message: msg }]
    const out = await collect()
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe(msg)
  })

  test('additionalContexts → hook_additional_context 附件', async () => {
    QUEUED = [{ additionalContexts: ['batch note'] }]
    const out = await collect()
    expect(out).toHaveLength(1)
    expect(out[0].message.type).toBe('attachment')
    expect(out[0].message.attachment.type).toBe('hook_additional_context')
    expect(out[0].message.attachment.content).toEqual(['batch note'])
    expect(out[0].message.attachment.hookEvent).toBe('PostToolBatch')
  })

  test('preventContinuation → hook_stopped_continuation 附件', async () => {
    QUEUED = [{ preventContinuation: true, stopReason: 'stop now' }]
    const out = await collect()
    expect(out).toHaveLength(1)
    expect(out[0].message.attachment.type).toBe('hook_stopped_continuation')
  })
})
