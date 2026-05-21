/**
 * buildOpenAIRequestParams 测试：标准 CreateParams → OpenAI 请求参数。
 *
 * 覆盖：
 * - 基本字段透传（model / max_tokens / temperature / top_p / stop）
 * - tools / tool_choice 转换
 * - providerExtras / extra_body 透传
 * - _web_search_tool 剥离
 * - thinking / output_config 转换
 */
import { describe, expect, test } from 'bun:test'
import { buildOpenAIRequestParams } from '../../../src/services/api/conversions/openai.js'

describe('buildOpenAIRequestParams', () => {
  test('基本字段透传', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
    } as any)

    expect(result.model).toBe('gpt-4')
    expect(result.max_tokens).toBe(4096)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
    // temperature 默认 1
    expect(result.temperature).toBe(1)
  })

  test('top_p / stop 透传', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      topP: 0.9,
      stopSequences: ['END', 'STOP'],
    } as any)

    expect(result.top_p).toBe(0.9)
    expect(result.stop).toEqual(['END', 'STOP'])
  })

  test('tools + tool_choice 传递', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'auto' },
    } as any)

    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe('search')
    expect(result.tool_choice).toBe('auto')
  })

  test('providerExtras.openai 透传（_web_search_tool 被剥离）', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      providerExtras: {
        openai: {
          _web_search_tool: { type: 'web_search_preview' },
          user: 'user-123',
        },
      },
    } as any)

    // _web_search_tool 被剥离出 cleanedExtras
    expect((result as any).user).toBe('user-123')
    expect((result as any)._web_search_tool).toBeUndefined()
  })

  test('web_search_tool 注入到 tools 数组', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      providerExtras: {
        openai: {
          _web_search_tool: { type: 'web_search_preview' },
        },
      },
    } as any)

    expect(result.tools).toHaveLength(1)
    expect((result.tools![0] as any).type).toBe('web_search_preview')
  })

  test('extra_body 顶层透传', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      extra_body: { custom_flag: true },
    } as any)

    expect((result as any).custom_flag).toBe(true)
  })

  test('response_format 从 providerExtras 读取', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      providerExtras: {
        openai: {
          response_format: { type: 'json_object' },
        },
      },
    } as any)

    expect(result.response_format).toEqual({ type: 'json_object' })
  })

  test('response_format 从 output_config 转换', () => {
    const result = buildOpenAIRequestParams({
      model: 'gpt-4',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: {
        format: { type: 'json_object' },
      },
    } as any)

    expect(result.response_format).toEqual({ type: 'json_object' })
  })
})
