/**
 * 5.2 executePostToolBatchHooks —— gate 短路 + 输出转换（additionalContext / preventContinuation
 * → 消息），供 query.ts 按 toolUpdates 方式消费。mock executeHooks + hasHookForEvent。
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as realAttachments from '../../../src/services/attachments/attachments.js'

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
  // 确保 createAttachmentMessage 使用真实实现，避免被其他测试文件的 mock 污染
  mock.module('../../../src/services/attachments/attachments.js', () => ({
    ...realAttachments,
  }))
  mock.module('../../../src/services/hooks/executeEngine.js', () => ({
    executeHooks: async function* () {
      for (const r of QUEUED) {
        yield r
      }
    },
  }))
  const matcher = await import('../../../src/services/hooks/matcher.js')
  mock.module('../../../src/services/hooks/matcher.js', () => ({
    ...matcher,
    hasHookForEvent: () => HAS_HOOK,
  }))
  ;({ executePostToolBatchHooks } = await import('../../../src/services/hooks/executors/tool.js'))
})

const ctx = {
  getAppState: () => ({}),
  abortController: { signal: undefined },
  // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
} as any
const toolUses = [{ tool_name: 'Bash', tool_use_id: 't1', status: 'success' as const }]

// biome-ignore lint/suspicious/noExplicitAny: 测试收集动态 hook 输出
async function collect(): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
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
