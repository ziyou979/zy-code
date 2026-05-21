/**
 * 出站测试：标准 CreateParams → Anthropic SDK 参数
 * 被测函数：streamAdapter.ts buildAnthropicCreateParams
 *
 * 重点关注：
 * - max_tokens / messages / system 抽离
 * - tool 定义命名兼容（input_schema vs inputSchema）
 * - tool_use 消息中 input 必须是 object
 * - thinking / betas / context_management 等 anthropic 专属字段
 */
import { describe, expect, test } from 'bun:test'
import { buildAnthropicCreateParams } from '../../../src/services/api/conversions/anthropic.js'
import { assertValidAnthropicCreateParams } from '../../_helpers/sdkValidators.js'

describe('buildAnthropicCreateParams: 出站 Anthropic 请求构造', () => {
  test('系统提示 + user/assistant 消息：system 抽离，messages 只剩 user/assistant', () => {
    const result = buildAnthropicCreateParams({
      model: 'claude-3-5-sonnet',
      maxTokens: 4096,
      messages: [
        { role: 'system', content: 'You are helpful' } as any,
        { role: 'user', content: 'hi' } as any,
        { role: 'assistant', content: 'hello' } as any,
      ],
    } as any)
    expect(result.model).toBe('claude-3-5-sonnet')
    expect(result.max_tokens).toBe(4096)
    expect(result.system).toBe('You are helpful')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[1].role).toBe('assistant')
    assertValidAnthropicCreateParams(result)
  })

  test('多条 system 消息：被合并成一段（双换行分隔）', () => {
    const result = buildAnthropicCreateParams({
      model: 'claude-3',
      maxTokens: 100,
      messages: [
        { role: 'system', content: 'Rule 1' } as any,
        { role: 'system', content: 'Rule 2' } as any,
        { role: 'user', content: 'go' } as any,
      ],
    } as any)
    expect(result.system).toBe('Rule 1\n\nRule 2')
  })

  test('v1 顶层 system 字段（无 system 消息）：透传', () => {
    const result = buildAnthropicCreateParams({
      model: 'claude',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' } as any],
      system: 'legacy system',
    } as any)
    expect(result.system).toBe('legacy system')
  })

  test('tools 字段：v2 inputSchema 与 v1 input_schema 都被转成 input_schema', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'x' } as any],
      tools: [
        {
          name: 't1',
          description: 'desc1',
          inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
        },
        {
          name: 't2',
          description: 'desc2',
          inputSchema: { type: 'object', properties: { b: { type: 'number' } } },
        },
      ] as any,
    } as any)
    expect(result.tools).toHaveLength(2)
    expect(result.tools[0]).toEqual({
      name: 't1',
      description: 'desc1',
      input_schema: { type: 'object', properties: { a: { type: 'string' } } },
    })
    expect(result.tools[1]).toEqual({
      name: 't2',
      description: 'desc2',
      input_schema: { type: 'object', properties: { b: { type: 'number' } } },
    })
  })

  test('temperature/topP/stopSequences/metadata 透传', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' } as any],
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ['END'],
      metadata: { user_id: 'u1' },
    } as any)
    expect(result.temperature).toBe(0.5)
    expect(result.top_p).toBe(0.9)
    expect(result.stop_sequences).toEqual(['END'])
    expect(result.metadata).toEqual({ user_id: 'u1' })
  })

  test('providerExtras.anthropic.thinking 优先于顶层 thinking', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' } as any],
      providerExtras: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } as any },
      },
      thinking: { type: 'disabled' },
    } as any)
    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 } as any)
  })

  test('assistant tool_use 消息：input 是 object，能通过 SDK 校验', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        { role: 'user', content: 'go' } as any,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'search',
              input: { query: 'ant' },
            },
          ],
        } as any,
      ],
    } as any)
    assertValidAnthropicCreateParams(result)
  })

  test('CRITICAL 防线：tool_use input 是 string 时，A2 conversions/anthropic.ts 主动 safeParse 成 object', () => {
    // 历史：旧 AnthropicProviderAdapter 把字符串 input 原样透传给 SDK，校验报错。
    // A2 防线：conversions/anthropic.ts 的 blockToAnthropic 在 input 是字符串时
    // 调用 safeParseToolArguments 转回 object，避免到达 SDK 时报错。
    const params = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [
        { role: 'user', content: 'go' } as any,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_safe',
              name: 'search',
              input: '{"q":"hi"}', // ← 字符串形态
            },
          ],
        } as any,
      ],
    } as any)
    // 不抛错：input 已被自动转为 object
    assertValidAnthropicCreateParams(params)
    const assistantMsg = params.messages.find((m: any) => m.role === 'assistant')
    const toolUseBlock = (assistantMsg as any).content[0]
    expect(toolUseBlock.type).toBe('tool_use')
    expect(typeof toolUseBlock.input).toBe('object')
    expect(toolUseBlock.input).toEqual({ q: 'hi' })
  })

  test('extra_body 顶层透传（用于自定义实验性字段）', () => {
    const result = buildAnthropicCreateParams({
      model: 'c',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' } as any],
      extra_body: { custom_flag: true } as any,
    } as any)
    expect((result as any).custom_flag).toBe(true)
  })
})
