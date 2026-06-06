/**
 * 5.5 mcp_tool hook —— schema 接受性 + execMcpToolHook（连接检查 / 结果提取 / args 合并 / fail-open）。
 * mock callMCPTool（可控返回/抛错 + 捕获 args）；全替换 i18n 防 schema/attachments 图的 settings TDZ。
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let CONTENT: unknown = 'hello'
let THROW = false
let CAPTURED_ARGS: Record<string, unknown> | undefined

// biome-ignore lint/suspicious/noExplicitAny: 动态导入
let HookCommandSchema: any
// biome-ignore lint/suspicious/noExplicitAny: 动态导入
let execMcpToolHook: any

beforeAll(async () => {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (k: string) => k,
    t: (k: string) => k,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  const mcpToolCall = await import('../../../src/services/mcp/mcpToolCall.js')
  mock.module('../../../src/services/mcp/mcpToolCall.js', () => ({
    ...mcpToolCall,
    callMCPTool: async ({ args }: { args: Record<string, unknown> }) => {
      CAPTURED_ARGS = args
      if (THROW) {
        throw new Error('mcp boom')
      }
      return { content: CONTENT }
    },
  }))
  ;({ HookCommandSchema } = await import('../../../src/schemas/hooks.js'))
  ;({ execMcpToolHook } = await import('../../../src/utils/hooks/execMcpToolHook.js'))
})

const hook = { type: 'mcp_tool' as const, server: 'srv', tool: 'lint', args: { strict: true } }
const ctxWith = (connected: boolean) =>
  ({
    getAppState: () => ({
      mcp: { clients: connected ? [{ name: 'srv', type: 'connected', client: {} }] : [] },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
  }) as any
// biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
const run = (toolUseCtx: any, jsonInput = '{"hook_event_name":"PostToolUse","tool_name":"Bash"}') =>
  execMcpToolHook(hook, 'PostToolUse:Bash', 'PostToolUse', jsonInput, undefined, toolUseCtx, 'tu1')

describe('5.5 mcp_tool schema', () => {
  test('HookCommandSchema 接受 mcp_tool', () => {
    const r = HookCommandSchema().safeParse({ type: 'mcp_tool', server: 's', tool: 't' })
    expect(r.success).toBe(true)
  })
  test('mcp_tool 必须有 server + tool', () => {
    expect(HookCommandSchema().safeParse({ type: 'mcp_tool', server: 's' }).success).toBe(false)
  })
})

describe('5.5 execMcpToolHook', () => {
  beforeEach(() => {
    CONTENT = 'hello'
    THROW = false
    CAPTURED_ARGS = undefined
  })

  test('server 未连接 → 非阻塞错误', async () => {
    const r = await run(ctxWith(false))
    expect(r.outcome).toBe('non_blocking_error')
    expect(r.additionalContext).toBeUndefined()
  })

  test('字符串结果 → additionalContext + success', async () => {
    CONTENT = 'lint passed'
    const r = await run(ctxWith(true))
    expect(r.outcome).toBe('success')
    expect(r.additionalContext).toBe('lint passed')
  })

  test('ContentBlock[] 结果 → 提取并拼接 text 块', async () => {
    CONTENT = [
      { type: 'text', text: 'line1' },
      { type: 'image', source: {} },
      { type: 'text', text: 'line2' },
    ]
    const r = await run(ctxWith(true))
    expect(r.outcome).toBe('success')
    expect(r.additionalContext).toBe('line1\nline2')
  })

  test('args = 事件 JSON 合并 hook.args（静态参数优先）', async () => {
    await run(ctxWith(true))
    expect(CAPTURED_ARGS).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      strict: true,
    })
  })

  test('callMCPTool 抛错 → fail-open 非阻塞错误', async () => {
    THROW = true
    const r = await run(ctxWith(true))
    expect(r.outcome).toBe('non_blocking_error')
  })
})
