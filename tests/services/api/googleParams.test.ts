/**
 * Google 原生格式出站参数测试。
 */
import { describe, expect, test } from 'bun:test'
import { buildGoogleRequestParams } from '../../../src/services/api/conversions/google.js'

describe('buildGoogleRequestParams: 出站 Google 请求构造', () => {
  test('并行工具结果完成顺序相反时，按调用顺序回传且不修改原始历史', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Run both.' }] },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_call' as const,
            id: 'a',
            name: 'echo',
            input: {},
            providerMetadata: { googleThoughtSignature: 'signed-first' },
          },
          { type: 'tool_call' as const, id: 'b', name: 'echo', input: {} },
        ],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, toolCallId: 'b', content: 'B' }],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, toolCallId: 'a', content: 'A' }],
      },
    ]
    const original = structuredClone(messages)
    const request = buildGoogleRequestParams({ model: 'gemini-4-argon', maxTokens: 128, messages })
    expect(request.contents.at(-1)?.parts.map((part) => part.functionResponse?.id)).toEqual([
      'a',
      'b',
    ])
    expect(messages).toEqual(original)
    expect(request.contents[1]?.parts[0]?.thoughtSignature).toBe('signed-first')
  })
  test('顶层系统提示与全部 system 消息都传给 Google，不混入对话轮次', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-4-argon',
      maxTokens: 128,
      system: [{ type: 'text', text: 'Top-level instruction.' }],
      messages: [
        { role: 'system', content: 'First instruction.' },
        { role: 'system', content: 'Second instruction.' },
        { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
      ],
    })
    expect(result.systemInstruction?.parts).toEqual([
      { text: 'Top-level instruction.' },
      { text: 'First instruction.' },
      { text: 'Second instruction.' },
    ])
    expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi.' }] }])
  })
  test('工具结果与 go on 即使被通用层合并，也恢复为独立的 Google 轮次', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-4-argon',
      maxTokens: 128,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run the fixture.' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'a',
              name: 'Bash',
              input: {},
              providerMetadata: { googleThoughtSignature: 'signed-call' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: 'a', content: 'OK' },
            { type: 'text', text: 'go on' },
          ],
        },
      ],
    })
    expect(result.contents.slice(-2)).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'Bash', id: 'a', response: { output: 'OK' } } }],
      },
      { role: 'user', parts: [{ text: 'go on' }] },
    ])
  })
  test('并行调用与各自结果集中回传，保留仅第一个调用上的签名', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-4-argon',
      maxTokens: 128,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run both fixtures.' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'a',
              name: 'echo',
              input: { value: 'a' },
              providerMetadata: { googleThoughtSignature: 'first-only' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'b', name: 'echo', input: { value: 'b' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'a', content: 'a' }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'b', content: 'b' }] },
      ],
    })
    expect(result.contents.map((content) => content.role)).toEqual(['user', 'model', 'user'])
    expect(result.contents[1]?.parts.map((part) => part.thoughtSignature)).toEqual([
      'first-only',
      undefined,
    ])
    expect(result.contents[2]?.parts.map((part) => part.functionResponse?.id)).toEqual(['a', 'b'])
  })
  test('生成请求尾部 model 在本地拒绝，计数请求仍能统计同一历史', () => {
    const params = {
      model: 'gemini-4-argon',
      maxTokens: 128,
      messages: [
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'unfinished' }] },
      ],
    }
    expect(() => buildGoogleRequestParams(params)).toThrow()
    expect(buildGoogleRequestParams(params, 'json-schema', 'count').contents[0]?.role).toBe('model')
  })
  test('空用户消息被跳过，不发送空 parts 冒充有效请求', () => {
    expect(() =>
      buildGoogleRequestParams({
        model: 'gemini-4-argon',
        maxTokens: 1,
        messages: [{ role: 'user', content: [] }],
      }),
    ).toThrow()
  })
  test.each([
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
  ])('新一代 %s 只使用思考强度，不带预算', (model) => {
    const config = buildGoogleRequestParams({
      model,
      maxTokens: 128,
      reasoningEffort: 'low',
      thinking: { type: 'enabled', budgetTokens: 1024 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi.' }] }],
    }).generationConfig?.thinkingConfig
    expect(config).toEqual({ thinkingLevel: 'LOW', includeThoughts: true })
  })
  test('3.8 已弃用的采样参数不发送，2.5 仍保留', () => {
    const params = {
      maxTokens: 128,
      temperature: 0.5,
      topP: 0.9,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi.' }] }],
    }
    expect(
      buildGoogleRequestParams({ ...params, model: 'gemini-3.8-flash' }).generationConfig
        ?.temperature,
    ).toBeUndefined()
    expect(
      buildGoogleRequestParams({ ...params, model: 'gemini-2.5-flash' }).generationConfig
        ?.temperature,
    ).toBe(0.5)
  })
  test('顶层 disabled thinking → thinkingBudget 0', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  test('顶层 enabled thinking + reasoningEffort → Google thinkingConfig', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-pro',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      thinking: { type: 'enabled', budgetTokens: 2048 },
      reasoningEffort: 'xhigh',
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    })
  })

  test('responseFormat.json_schema → response schema', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    }
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      responseFormat: { type: 'json_schema', schema },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.responseMimeType).toBe('application/json')
    expect(result.generationConfig?.responseSchema).toEqual(schema)
  })

  test('toolChoice tool → Google ANY + allowedFunctionNames', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'search' },
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['search'],
      },
    })
    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  test('出站 functionCall Part 必须携带 thoughtSignature，且严格位于 Part 顶层而不在 functionCall 内部', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-pro',
      maxTokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read file' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_read_1',
              name: 'default_api:Read',
              input: { path: 'a.txt' },
              providerMetadata: { googleThoughtSignature: 'sig_token_abc123' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_read_1',
              content: 'file contents',
            },
          ],
        },
      ],
    })

    const modelPart = result.contents[1]?.parts[0]
    expect(modelPart?.thoughtSignature).toBe('sig_token_abc123')
    expect(modelPart?.functionCall?.name).toBe('default_api:Read')
    // 按照 Google REST 协议规范，functionCall 对象内部不得包含 thoughtSignature 字段
    const rawCall = modelPart?.functionCall as Record<string, unknown> | undefined
    const rawPart = modelPart as Record<string, unknown> | undefined
    expect(rawCall?.thoughtSignature).toBeUndefined()
    expect(rawCall?.thought_signature).toBeUndefined()
    expect(rawPart?.thought_signature).toBeUndefined()
  })

  test('同一个 assistant 消息内 thinking 块的签名能自动赋给同轮缺少签名的 tool_call', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-pro',
      maxTokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read file' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I need to call Read',
              signature: 'sig_from_thinking_turn',
            },
            {
              type: 'tool_call',
              id: 'call_read_2',
              name: 'default_api:Read',
              input: { path: 'b.txt' },
              // 未显式挂载 providerMetadata
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_read_2',
              content: 'file contents 2',
            },
          ],
        },
      ],
    })

    const toolPart = result.contents[1]?.parts.find(
      (p) => p.functionCall?.name === 'default_api:Read',
    )
    const rawToolPart = toolPart as Record<string, unknown> | undefined
    const rawToolCall = toolPart?.functionCall as Record<string, unknown> | undefined
    expect(toolPart?.thoughtSignature).toBe('sig_from_thinking_turn')
    expect(rawToolPart?.thought_signature).toBeUndefined()
    expect(rawToolCall?.thoughtSignature).toBeUndefined()
    expect(rawToolCall?.thought_signature).toBeUndefined()
  })

  test('多条连续 assistant 消息在同一轮中，后序 assistant 的 tool_call 能继承前序 assistant 的 thinking 签名', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-pro',
      maxTokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read file' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I need to call Read',
              signature: 'sig_cross_assistant_turn',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_read_split',
              name: 'default_api:Read',
              input: { path: 'c.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_read_split',
              content: 'file contents 3',
            },
          ],
        },
      ],
    })

    const toolPart = result.contents[1]?.parts.find(
      (p) => p.functionCall?.name === 'default_api:Read',
    )
    const rawToolCall = toolPart?.functionCall as Record<string, unknown> | undefined
    expect(toolPart?.thoughtSignature).toBe('sig_cross_assistant_turn')
    expect(rawToolCall?.thoughtSignature).toBeUndefined()
  })
})
