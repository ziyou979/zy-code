/**
 * OpenAI Responses 转换工具函数测试：toolsToResponses / toolChoiceToResponses /
 * convertThinkingForResponses / messagesToResponses / responsesToStandard /
 * mapResponsesStreamToStandard 等。
 *
 * 与 openaiFunctions.test.ts 一致：纯函数测试，不 mock SDK。
 */

import { describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import type { JSONOutputFormat, LLMMessage, ToolDefinition } from '../../../src/types/llm.js'
import {
  buildResponsesRequestParams,
  convertOutputFormatToResponsesText,
  convertThinkingForResponses,
  mapResponsesStreamToStandard,
  messagesToResponses,
  responsesStatusToStopReason,
  responsesToStandard,
  responsesUsageToStandard,
  toolChoiceToResponses,
  toolsToResponses,
} from '../../../src/services/api/conversions/openaiResponses.js'

/** 把部分字段的对象断言为 SDK 事件类型（测试构造便利）。 */
function ev<T>(partial: unknown): T {
  return partial as T
}

describe('toolsToResponses', () => {
  test('undefined → undefined', () => {
    expect(toolsToResponses(undefined)).toBeUndefined()
  })

  test('空数组 → undefined', () => {
    expect(toolsToResponses([])).toBeUndefined()
  })

  test('工具定义带 inputSchema → 扁平结构（无 function 嵌套、无 strict）', () => {
    const result = toolsToResponses([
      {
        name: 'search',
        description: 'Search web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ])
    expect(result).toMatchObject([
      {
        type: 'function',
        name: 'search',
        description: 'Search web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ])
    // 与 Chat Completions 的关键差异：无 function 嵌套层
    expect((result![0] as unknown as Record<string, unknown>).function).toBeUndefined()
    // strict 运行时省略（官方「尝试严格模式失败回退」）
    expect((result![0] as unknown as Record<string, unknown>).strict).toBeUndefined()
  })

  test('工具定义带 input_schema（v1 旧名）→ 兼容', () => {
    const result = toolsToResponses([
      {
        name: 'f',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      } as unknown as ToolDefinition,
    ])
    expect(result![0]).toMatchObject({ parameters: { type: 'object', properties: {} } })
  })

  test('工具定义无 schema → 默认空 object', () => {
    const result = toolsToResponses([{ name: 'f', description: 'd' } as unknown as ToolDefinition])
    expect(result![0]).toMatchObject({ parameters: { type: 'object', properties: {} } })
  })
})

describe('toolChoiceToResponses', () => {
  test('undefined → undefined', () => {
    expect(toolChoiceToResponses(undefined)).toBeUndefined()
  })

  test('auto → "auto"', () => {
    expect(toolChoiceToResponses({ type: 'auto' })).toBe('auto')
  })

  test('none → "none"', () => {
    expect(toolChoiceToResponses({ type: 'none' })).toBe('none')
  })

  test('tool → { type: "function", name }（扁平，无 function 嵌套）', () => {
    expect(toolChoiceToResponses({ type: 'tool', name: 'search' })).toEqual({
      type: 'function',
      name: 'search',
    })
  })

  test('未知 type → undefined', () => {
    expect(
      toolChoiceToResponses({ type: 'unknown' } as unknown as Parameters<
        typeof toolChoiceToResponses
      >[0]),
    ).toBeUndefined()
  })
})

describe('convertThinkingForResponses', () => {
  test('undefined → undefined（不传 reasoning）', () => {
    expect(convertThinkingForResponses(undefined)).toBeUndefined()
  })

  test('disabled → undefined（Responses 无显式关闭机制）', () => {
    expect(convertThinkingForResponses({ type: 'disabled' })).toBeUndefined()
  })

  test('enabled + effort high → reasoning.effort high', () => {
    expect(convertThinkingForResponses({ type: 'enabled', budgetTokens: 1024 }, 'high')).toEqual({
      reasoning: { effort: 'high' },
    })
  })

  test('enabled + effort low → reasoning.effort low', () => {
    expect(convertThinkingForResponses({ type: 'enabled', budgetTokens: 1024 }, 'low')).toEqual({
      reasoning: { effort: 'low' },
    })
  })

  test('enabled + 无 effort → 默认 medium', () => {
    expect(convertThinkingForResponses({ type: 'enabled', budgetTokens: 1024 })).toEqual({
      reasoning: { effort: 'medium' },
    })
  })

  test('enabled + 未知档位（extreme）→ 收敛 medium', () => {
    expect(convertThinkingForResponses({ type: 'enabled', budgetTokens: 1024 }, 'extreme')).toEqual(
      { reasoning: { effort: 'medium' } },
    )
  })

  test('adaptive → 按 effort 映射（默认 medium）', () => {
    expect(convertThinkingForResponses({ type: 'adaptive' }, 'high')).toEqual({
      reasoning: { effort: 'high' },
    })
  })
})

describe('convertOutputFormatToResponsesText', () => {
  test('undefined → undefined', () => {
    expect(convertOutputFormatToResponsesText(undefined)).toBeUndefined()
  })

  test('json_object → text.format json_object', () => {
    expect(convertOutputFormatToResponsesText({ type: 'json_object' })).toEqual({
      format: { type: 'json_object' },
    })
  })

  test('json_schema + schema → 原生 json_schema（优于 chat 的 json_object 兜底）', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } }
    expect(convertOutputFormatToResponsesText({ type: 'json_schema', schema })).toEqual({
      format: { type: 'json_schema', name: 'structured_output', schema },
    })
  })

  test('json_schema 无 schema → 退化 json_object', () => {
    expect(
      convertOutputFormatToResponsesText({ type: 'json_schema' } as unknown as JSONOutputFormat),
    ).toEqual({
      format: { type: 'json_object' },
    })
  })

  test('已知非标准 type → 原样透传', () => {
    const result = convertOutputFormatToResponsesText({
      type: 'text',
    } as unknown as JSONOutputFormat)
    expect(result).toMatchObject({ type: 'text' })
  })
})

describe('messagesToResponses', () => {
  test('system 消息不产生 item（由 instructions 承载）', () => {
    const result = messagesToResponses([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'message', role: 'user' })
  })

  test('user 文本 → message item（input_text）', () => {
    const result = messagesToResponses([
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ])
    expect(result).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    ])
  })

  test('user 图片 → input_image（data URL）', () => {
    const result = messagesToResponses([
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
    ])
    expect(result[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }],
    })
  })

  test('user 内嵌 tool_result → 拆为 function_call_output item（先于 user 消息）', () => {
    const result = messagesToResponses([
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: '结果是 42' },
          { type: 'text', text: '继续' },
        ],
      },
    ])
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '结果是 42' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ])
  })

  test('assistant 文本 + tool_call → message item + function_call item（arguments 为 JSON 字符串）', () => {
    const result = messagesToResponses([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考中', signature: '' },
          { type: 'text', text: '我来搜索' },
          { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test' } },
        ],
      },
    ])
    expect(result).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_text', text: '我来搜索' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":"test"}',
      },
    ])
  })

  test('assistant 纯 thinking → 丢弃，无 item', () => {
    const result = messagesToResponses([
      { role: 'assistant', content: [{ type: 'thinking', thinking: '思考', signature: '' }] },
    ])
    expect(result).toHaveLength(0)
  })

  test('tool 消息 → function_call_output item', () => {
    const result = messagesToResponses([
      { role: 'tool', toolCallId: 'call_1', content: '执行结果' },
    ])
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '执行结果' },
    ])
  })

  test('多轮工具循环顺序：assistant call 在 user output 之前', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '查天气' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'weather', input: { city: '北京' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: '晴' }],
      },
    ]
    const result = messagesToResponses(messages)
    // function_call 必须在其 function_call_output 之前
    const callIdx = result.findIndex((item) => item.type === 'function_call')
    const outputIdx = result.findIndex((item) => item.type === 'function_call_output')
    expect(callIdx).toBeGreaterThanOrEqual(0)
    expect(outputIdx).toBeGreaterThan(callIdx)
  })
})

describe('responsesStatusToStopReason', () => {
  test('completed → end_turn', () => {
    expect(responsesStatusToStopReason('completed')).toBe('end_turn')
  })

  test('incomplete + max_output_tokens → max_tokens', () => {
    expect(responsesStatusToStopReason('incomplete', { reason: 'max_output_tokens' })).toBe(
      'max_tokens',
    )
  })

  test('incomplete + content_filter → content_filter', () => {
    expect(responsesStatusToStopReason('incomplete', { reason: 'content_filter' })).toBe(
      'content_filter',
    )
  })

  test('failed → null', () => {
    expect(responsesStatusToStopReason('failed')).toBeNull()
  })

  test('undefined → null', () => {
    expect(responsesStatusToStopReason(undefined)).toBeNull()
  })
})

describe('responsesUsageToStandard', () => {
  test('正常 usage → 缓存与 reasoning 计数', () => {
    const result = responsesUsageToStandard({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 15 },
    })
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(20)
    expect(result.cacheReadInputTokens).toBe(40)
    expect(result.extras).toEqual({ reasoning_tokens: 15 })
  })

  test('undefined → 全 0 缺省', () => {
    const result = responsesUsageToStandard(undefined)
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.cacheReadInputTokens).toBeUndefined()
    expect(result.extras).toBeUndefined()
  })
})

describe('responsesToStandard', () => {
  const baseResponse = {
    id: 'resp_1',
    model: 'gpt-5',
    object: 'response' as const,
    status: 'completed' as const,
    created_at: 0,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output: [],
    parallel_tool_calls: false,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  }

  test('output 按序：reasoning → message → function_call → 对应 blocks', () => {
    const response = {
      ...baseResponse,
      output: [
        {
          type: 'reasoning' as const,
          id: 'rs_1',
          summary: [{ type: 'summary_text' as const, text: '第一步思考' }],
          status: 'completed' as const,
        },
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: '结果如下', annotations: [] }],
        },
        {
          type: 'function_call' as const,
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed' as const,
        },
      ],
    }
    const result = responsesToStandard(response as unknown as OpenAI.Responses.Response, 'gpt-5')
    expect(result.content).toEqual([
      { type: 'thinking', thinking: '第一步思考', signature: '' },
      { type: 'text', text: '结果如下' },
      { type: 'tool_call', id: 'call_1', name: 'search', input: { q: 'test' } },
    ])
    // 含 function_call → stopReason 为 tool_use（completed status 无法区分）
    expect(result.stopReason).toBe('tool_use')
    expect(result.usage.extras).toEqual({ reasoning_tokens: 2 })
  })

  test('仅 message → end_turn', () => {
    const response = {
      ...baseResponse,
      output: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: '你好', annotations: [] }],
        },
      ],
    }
    const result = responsesToStandard(response as unknown as OpenAI.Responses.Response, 'gpt-5')
    expect(result.content).toEqual([{ type: 'text', text: '你好' }])
    expect(result.stopReason).toBe('end_turn')
  })

  test('function_call arguments 非法 JSON → input 空对象', () => {
    const response = {
      ...baseResponse,
      output: [
        {
          type: 'function_call' as const,
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search',
          arguments: 'not-json',
          status: 'completed' as const,
        },
      ],
    }
    const result = responsesToStandard(response as unknown as OpenAI.Responses.Response, 'gpt-5')
    expect(result.content[0]).toMatchObject({ type: 'tool_call', input: {} })
  })

  test('incomplete status → max_tokens', () => {
    const response = {
      ...baseResponse,
      status: 'incomplete' as const,
      incomplete_details: { reason: 'max_output_tokens' as const },
      output: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'incomplete' as const,
          content: [{ type: 'output_text' as const, text: '部分输出', annotations: [] }],
        },
      ],
    }
    const result = responsesToStandard(response as unknown as OpenAI.Responses.Response, 'gpt-5')
    expect(result.stopReason).toBe('max_tokens')
  })
})

describe('mapResponsesStreamToStandard', () => {
  async function collect(events: OpenAI.Responses.ResponseStreamEvent[]) {
    const eventsOut: Array<{
      type: string
      index?: number
      stopReason?: unknown
      usage?: unknown
    }> = []
    for await (const event of mapResponsesStreamToStandard(
      events as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
      'gpt-5',
    )) {
      eventsOut.push({
        type: event.type,
        index: (event as { index?: number }).index,
        stopReason: (event as { stopReason?: unknown }).stopReason,
        usage: (event as { usage?: unknown }).usage,
      })
    }
    return eventsOut
  }

  test('纯文本流：output_text.delta → text 块，completed 时收尾', async () => {
    const events = await collect([
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: '你',
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        delta: '好',
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.completed',
        sequence_number: 3,
        response: ev<OpenAI.Responses.Response>({
          id: 'resp_1',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      }),
    ])

    expect(events.map((e) => e.type)).toEqual([
      'response_start',
      'chunk_start',
      'chunk_delta',
      'chunk_delta',
      'chunk_stop',
      'response_delta',
      'response_stop',
    ])
    expect(events[1]).toMatchObject({ index: 0 })
    // usage 只在 completed 事件的 response_delta 中返回
    const delta = events[5]
    expect(delta.type).toBe('response_delta')
    expect(delta.stopReason).toBe('end_turn')
    expect(delta.usage).toMatchObject({ inputTokens: 10, cacheReadInputTokens: 3 })
  })

  test('思考 + 文本 + 工具调用：块切换补 chunk_stop，工具参数按 item_id 聚合', async () => {
    const events = await collect([
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        delta: '思考摘要',
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        sequence_number: 2,
        delta: '调用工具',
      }),
      // 工具 item 创建（带函数名）
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.output_item.added',
        output_index: 2,
        sequence_number: 3,
        item: ev<OpenAI.Responses.ResponseOutputItem>({
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search',
          arguments: '',
          status: 'in_progress',
        }),
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 2,
        sequence_number: 4,
        delta: '{"q":',
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 2,
        sequence_number: 5,
        delta: '"test"}',
      }),
      ev<OpenAI.Responses.ResponseStreamEvent>({
        type: 'response.completed',
        sequence_number: 6,
        response: ev<OpenAI.Responses.Response>({
          id: 'resp_1',
          status: 'completed',
          output: [
            ev<OpenAI.Responses.ResponseOutputItem>({
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'search',
              arguments: '{"q":"test"}',
              status: 'completed',
            }),
          ],
        }),
      }),
    ])

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'response_start',
      'chunk_start', // thinking 块
      'chunk_delta',
      'chunk_stop', // thinking → text 切换
      'chunk_start', // text 块
      'chunk_delta',
      'chunk_stop', // text → tool 切换
      'chunk_start', // tool 块（带函数名）
      'chunk_delta', // 参数片段 1
      'chunk_delta', // 参数片段 2
      'chunk_stop', // completed 收尾
      'response_delta',
      'response_stop',
    ])
    // tool 块 chunk_start 携带函数名
    const toolStart = events[7]
    expect(toolStart.type).toBe('chunk_start')
    expect(toolStart.index).toBe(2)
    // completed 含 function_call → stopReason tool_use
    expect(events[11]).toMatchObject({ type: 'response_delta', stopReason: 'tool_use' })
  })

  test('error 事件 → 抛错', async () => {
    const stream = mapResponsesStreamToStandard(
      [
        ev<OpenAI.Responses.ResponseStreamEvent>({
          type: 'error',
          code: 'server_error',
          message: 'boom',
        }),
      ] as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
      'gpt-5',
    )
    // 消费全部事件，error 事件在 response_start 之后到达时抛错
    await expect(
      (async () => {
        for await (const _event of stream) {
          // 逐事件消费直到抛错
        }
      })(),
    ).rejects.toThrow(/boom/)
  })
})

describe('buildResponsesRequestParams', () => {
  test('基本字段：input items + instructions + max_output_tokens', () => {
    const params = buildResponsesRequestParams({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
      maxTokens: 100,
    } as unknown as Parameters<typeof buildResponsesRequestParams>[0])

    expect(params.model).toBe('gpt-5')
    expect(params.instructions).toBe('你是助手')
    expect(params.max_output_tokens).toBe(100)
    expect(params.input).toHaveLength(1)
    expect(params.tools).toBeUndefined()
  })

  test('thinking enabled + reasoningEffort → reasoning.effort（无 thinking 字段）', () => {
    const params = buildResponsesRequestParams({
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      thinking: { type: 'enabled', budgetTokens: 1024 },
      reasoningEffort: 'high',
    } as unknown as Parameters<typeof buildResponsesRequestParams>[0])

    expect(params.reasoning).toEqual({ effort: 'high' })
    expect((params as Record<string, unknown>).thinking).toBeUndefined()
  })

  test('thinking disabled → 不传 reasoning', () => {
    const params = buildResponsesRequestParams({
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof buildResponsesRequestParams>[0])

    expect(params.reasoning).toBeUndefined()
  })

  test('tools + tool_choice → 扁平 tools + 对应 tool_choice', () => {
    const params = buildResponsesRequestParams({
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'search' },
    } as unknown as Parameters<typeof buildResponsesRequestParams>[0])

    expect(params.tools).toMatchObject([
      { type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } },
    ])
    expect(params.tool_choice).toEqual({ type: 'function', name: 'search' })
  })

  test('responseFormat json_schema → text.format 原生 json_schema', () => {
    const params = buildResponsesRequestParams({
      model: 'gpt-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 100,
      responseFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    } as unknown as Parameters<typeof buildResponsesRequestParams>[0])

    expect(params.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'structured_output',
        schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    })
    expect((params as Record<string, unknown>).response_format).toBeUndefined()
  })
})
