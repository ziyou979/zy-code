/**
 * 4.1 MessageDisplay —— schema 接受性 + executor 的 gate / 聚合 / fail-open。
 *
 * executor 只 mock executeHooks（控制 yield）与 hasHookForEvent（控制 gate）；其余依赖
 * （createBaseHookInput / extractTextContent / getSessionId）用真实实现。全替换 i18n 切断
 * schema/config 图里顶层 tSync→settings 的循环初始化 TDZ。
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// executeHooks 的可控产出
let QUEUED: Array<{ transformedText?: string; hide?: boolean }> = []
let THROW = false
// hasHookForEvent 的可控 gate
let HAS_HOOK = true

// biome-ignore lint/suspicious/noExplicitAny: 动态导入的 schema/executor
let S: any
// biome-ignore lint/suspicious/noExplicitAny: 同上
let executeMessageDisplayHooks: any

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
      if (THROW) {
        throw new Error('boom')
      }
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

  S = await import('../../../src/types/hooks/schemas.js')
  ;({ executeMessageDisplayHooks } = await import(
    '../../../src/utils/hooks/executors/messageDisplay.js'
  ))
})

const ctx = { getAppState: () => ({}), abortController: { signal: undefined } } as any
const assistantMsg = (text: string) =>
  ({ uuid: 'u1', message: { content: text ? [{ type: 'text', text }] : [] } }) as any

describe('4.1 MessageDisplay schema', () => {
  test('HOOK_EVENTS 含 MessageDisplay', () => {
    expect(S.HOOK_EVENTS).toContain('MessageDisplay')
  })
  test('输入 schema 接受 message_id/role/text', () => {
    const r = S.MessageDisplayHookInputSchema().safeParse({
      session_id: 's',
      transcript_path: '/t',
      cwd: '/c',
      hook_event_name: 'MessageDisplay',
      message_id: 'm1',
      message_role: 'assistant',
      text: 'hello',
    })
    expect(r.success).toBe(true)
  })
  test('输出 schema 接受 transformedText/hide', () => {
    const r = S.MessageDisplayHookSpecificOutputSchema().safeParse({
      hookEventName: 'MessageDisplay',
      transformedText: 'masked',
      hide: false,
    })
    expect(r.success).toBe(true)
  })
})

describe('4.1 executeMessageDisplayHooks', () => {
  beforeEach(() => {
    QUEUED = []
    THROW = false
    HAS_HOOK = true
  })

  test('未配置 MessageDisplay hook → 返回 {}（gate 短路）', async () => {
    HAS_HOOK = false
    QUEUED = [{ transformedText: 'X' }]
    expect(await executeMessageDisplayHooks(assistantMsg('secret'), ctx)).toEqual({})
  })

  test('无可显示文本 → 返回 {}（不触发）', async () => {
    QUEUED = [{ transformedText: 'X' }]
    expect(await executeMessageDisplayHooks(assistantMsg(''), ctx)).toEqual({})
  })

  test('transformedText 透传', async () => {
    QUEUED = [{ transformedText: 'masked' }]
    expect(await executeMessageDisplayHooks(assistantMsg('secret'), ctx)).toEqual({
      transformedText: 'masked',
    })
  })

  test('hide 透传', async () => {
    QUEUED = [{ hide: true }]
    expect(await executeMessageDisplayHooks(assistantMsg('secret'), ctx)).toEqual({ hide: true })
  })

  test('多 hook：hide 取或、transformedText 后者覆盖', async () => {
    QUEUED = [{ transformedText: 'A' }, { hide: true }, { transformedText: 'B' }]
    expect(await executeMessageDisplayHooks(assistantMsg('secret'), ctx)).toEqual({
      transformedText: 'B',
      hide: true,
    })
  })

  test('hook 抛错 → fail-open 返回 {}（回退原文）', async () => {
    THROW = true
    expect(await executeMessageDisplayHooks(assistantMsg('secret'), ctx)).toEqual({})
  })
})
