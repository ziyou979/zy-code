import { describe, expect, test } from 'bun:test'
import {
  resolveVertexTarget,
  VertexGoogleProviderAdapter,
} from '../../../src/services/api/vertexGoogleProviderAdapter.js'
import {
  buildGoogleRequestParams,
  googleResponseToStandard,
  messagesToGoogle,
} from '../../../src/services/api/conversions/google.js'
import { parseGoogleSseStream } from '../../../src/services/api/googleSseStream.js'
import { parseAuthConfig } from '../../../src/services/auth/authConfig.js'
import {
  LLMConnectionError,
  LLMAbortError,
  type CreateParams,
  type LLMStreamEvent,
} from '../../../src/types/llm.js'

const params: CreateParams = {
  model: 'gemini-4-argon',
  maxTokens: 2048,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}
const target = {
  baseUrl:
    'https://aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/global/publishers/google',
  project: 'fixture-project',
  location: 'global',
  headers: new Headers({
    Authorization: 'Bearer fixture-token',
    'Content-Type': 'application/json',
  }),
}

describe('resolveVertexTarget', () => {
  test('命名连接的项目区域优先于环境变量', () => {
    expect(
      resolveVertexTarget(
        { vertex: { project: 'fixture-project', location: 'global' } },
        undefined,
        { GOOGLE_CLOUD_PROJECT: 'other-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
      ),
    ).toMatchObject({ project: 'fixture-project', location: 'global', baseUrl: target.baseUrl })
  })
  test('区域端点与路径同时匹配连接配置', () => {
    expect(
      resolveVertexTarget(
        { vertex: { project: 'fixture-project', location: 'eu' } },
        'https://aiplatform.googleapis.com/v1beta1',
        {},
      ),
    ).toMatchObject({
      baseUrl:
        'https://eu-aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/eu/publishers/google',
    })
  })
  test('支持完整 publisher 端点和 v1 路径', () => {
    expect(resolveVertexTarget({}, target.baseUrl.replace('v1beta1', 'v1'), {})).toMatchObject({
      project: 'fixture-project',
      location: 'global',
    })
  })
  test('无项目时不尝试认证或推理', () => {
    expect(() => resolveVertexTarget({}, undefined, {})).toThrow()
  })
  test.each([
    'https://fixture.invalid/v1beta1',
    'https://aiplatform.googleapis.com.fixture.invalid/v1beta1',
    'http://aiplatform.googleapis.com/v1beta1',
    'https://user@aiplatform.googleapis.com/v1beta1',
    'https://aiplatform.googleapis.com/v1beta1?key=oops',
  ])('拒绝把 ADC 发到无效端点 %s', (url) => {
    expect(() => resolveVertexTarget({ vertex: { project: 'fixture-project' } }, url, {})).toThrow()
  })
  test('ADC 连接不需要保存 API key', () => {
    expect(
      parseAuthConfig({
        vertex: {
          provider: 'vertex',
          apiFormat: 'google',
          credentialType: 'google-adc',
          vertex: { project: 'fixture-project', location: 'global' },
        },
      }),
    ).not.toBeNull()
  })
})

describe('VertexGoogleProviderAdapter', () => {
  test('安全拦截没有 candidate 也正常完成，不伪装连接错误', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => new Response('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'),
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    const events: LLMStreamEvent[] = []
    for await (const event of stream) {
      events.push(event)
    }
    expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
      stopReason: 'content_filter',
    })
    expect(events.at(-1)?.type).toBe('response_stop')
  })
  test('空闲看门狗可通过流控制器中止锁定的响应读取，不中止整个任务', async () => {
    const taskController = new AbortController()
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              })
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
                ),
              )
            },
          }),
        ),
    })
    const { stream } = await adapter.createStream(params, taskController.signal)
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'response_start' })
    if (!('controller' in stream) || !(stream.controller instanceof AbortController)) {
      throw new Error('Missing stream controller')
    }
    stream.controller.abort()
    await expect(
      (async () => {
        while (!(await iterator.next()).done) {}
      })(),
    ).rejects.toBeInstanceOf(LLMAbortError)
    expect(taskController.signal.aborted).toBe(false)
  })
  test('完成标记之后服务端 API 错误仍然传播', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () =>
        new Response(
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\ndata: {"error":{"code":429,"message":"rate limit"}}\n\n',
        ),
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    await expect(
      (async () => {
        for await (const _event of stream) {
        }
      })(),
    ).rejects.toMatchObject({ status: 429 })
  })
  test('原生 socket 错误转换为可重试连接错误', async () => {
    const socketError = Object.assign(new Error('socket closed'), { code: 'ConnectionClosed' })
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => {
        throw socketError
      },
    })
    try {
      await adapter.createStream(params, new AbortController().signal)
      throw new Error('expected connection failure')
    } catch (error) {
      expect(error).toBeInstanceOf(LLMConnectionError)
      expect(error).toMatchObject({ code: 'ECONNRESET', cause: socketError })
    }
  })
  test.each([true, false])('首 token 后断线依据完成标记处理：completed=%s', async (completed) => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n' +
                (completed
                  ? 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2}}\n\n'
                  : ''),
            ),
          )
        } else {
          controller.error(Object.assign(new Error('socket closed'), { code: 'ConnectionClosed' }))
        }
      },
    })
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => new Response(body),
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    const events: LLMStreamEvent[] = []
    const consume = async () => {
      for await (const event of stream) {
        events.push(event)
      }
    }
    if (completed) {
      await consume()
      expect(events.at(-1)?.type).toBe('response_stop')
      expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
        stopReason: 'end_turn',
        usage: { outputTokens: 2 },
      })
    } else {
      await expect(consume()).rejects.toBeInstanceOf(LLMConnectionError)
      expect(events.some((event) => event.type === 'response_stop')).toBe(false)
    }
    expect(events.find((event) => event.type === 'chunk_delta')).toMatchObject({
      delta: { text: 'hello' },
    })
  })
  test('流正常 EOF 但没有完成标记不能伪装成功', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () =>
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'),
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    await expect(
      (async () => {
        for await (const _event of stream) {
        }
      })(),
    ).rejects.toBeInstanceOf(LLMConnectionError)
  })
  test('完成后用户取消仍保留中止语义', async () => {
    const controller = new AbortController()
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(streamController) {
              if (!controller.signal.aborted) {
                streamController.enqueue(
                  new TextEncoder().encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'),
                )
                controller.abort()
              } else {
                streamController.error(controller.signal.reason)
              }
            },
          }),
        ),
    })
    const { stream } = await adapter.createStream(params, controller.signal)
    await expect(
      (async () => {
        for await (const _event of stream) {
        }
      })(),
    ).rejects.toBeInstanceOf(LLMAbortError)
  })
  test('完整工具 JSON Schema 使用专用字段，保留字典约束且不修改原始定义', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object' as const,
      properties: {
        dictionary: {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: { type: 'string' },
        },
      },
      required: ['dictionary'],
    }
    let body: Record<string, unknown> = {}
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init.body))
        return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      },
    })
    await adapter.createMessage(
      {
        ...params,
        tools: [{ name: 'dictionaryTool', inputSchema: schema }],
        responseFormat: { type: 'json_schema', schema },
      },
      new AbortController().signal,
    )
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: 'dictionaryTool', parametersJsonSchema: schema }] },
    ])
    expect(body.generationConfig).toMatchObject({
      responseJsonSchema: schema,
      responseMimeType: 'application/json',
    })
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.properties.dictionary.propertyNames).toEqual({ pattern: '^[a-z]+$' })
  })
  test('原生流式相同前缀的增量和同名无 ID 工具调用不会被丢弃', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'ha' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'ha' }] } }] },
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'Read', args: { path: 'a.ts' } } }] } },
        ],
      },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'Read', args: { path: 'b.ts' } } }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () =>
        new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')),
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    const events: LLMStreamEvent[] = []
    for await (const event of stream) {
      events.push(event)
    }
    expect(
      events
        .filter((event) => event.type === 'chunk_delta' && event.delta.type === 'text_delta')
        .map((event) =>
          event.type === 'chunk_delta' && event.delta.type === 'text_delta' ? event.delta.text : '',
        )
        .join(''),
    ).toBe('haha')
    expect(
      events.filter((event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call'),
    ).toHaveLength(2)
  })
  test('非流式使用 publisher 请求、Bearer 和原生内容', async () => {
    let url = ''
    let options: RequestInit | undefined
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async (input, init) => {
        url = String(input)
        options = init
        return Response.json({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
        })
      },
    })
    const response = await adapter.createMessage(
      { ...params, maxTokens: 100000 },
      new AbortController().signal,
    )
    expect(url).toBe(`${target.baseUrl}/models/gemini-4-argon:generateContent`)
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-token')
    expect(JSON.parse(String(options?.body))).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 100000, thinkingConfig: { thinkingLevel: 'MEDIUM' } },
    })
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
  })
  test('每次请求重新获取认证头，避免静态令牌到期', async () => {
    let calls = 0
    const headers: string[] = []
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => ({
        ...target,
        headers: new Headers({ Authorization: `Bearer fixture-${++calls}` }),
      }),
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers).get('Authorization') ?? '')
        return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      },
    })
    await adapter.createMessage(params, new AbortController().signal)
    await adapter.createMessage(params, new AbortController().signal)
    expect(headers).toEqual(['Bearer fixture-1', 'Bearer fixture-2'])
  })
  test('流式保留函数调用的思考签名', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () =>
        new Response(
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"path":"a.ts"}},"thoughtSignature":"fixture-signature"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    })
    const result = await adapter.createStream(params, new AbortController().signal)
    const events: LLMStreamEvent[] = []
    for await (const event of result.stream) {
      events.push(event)
    }
    expect(events.find((event) => event.type === 'chunk_start')).toMatchObject({
      chunk: {
        type: 'tool_call',
        providerMetadata: { googleThoughtSignature: 'fixture-signature' },
      },
    })
    expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
      stopReason: 'tool_use',
    })
  })
  test('上游状态码保留，供重试层识别', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => new Response('permission denied', { status: 403 }),
    })
    await expect(adapter.createMessage(params, new AbortController().signal)).rejects.toMatchObject(
      { status: 403 },
    )
  })
  test('取消后不发送网络请求', async () => {
    let calls = 0
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => {
        calls++
        return target
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.createStream(params, controller.signal)).rejects.toThrow()
    expect(calls).toBe(0)
  })
  test('Gemini 4 错误区域不发送推理请求', async () => {
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => ({ ...target, location: 'us-central1' }),
    })
    await expect(adapter.createMessage(params, new AbortController().signal)).rejects.toThrow()
  })
})

describe('Gemini 4 请求与历史', () => {
  test('SSE 多行 data 按事件拼接，跨包、注释和 CRLF 不破坏 JSON', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of [
          'event: message\r\n: heartbeat\r\ndata: {\r\nda',
          'ta: "candidates": [{"content":{"parts":[{"text":"OK"}]}}]\r\ndata: }\r\n\r\n',
        ]) {
          controller.enqueue(new TextEncoder().encode(text))
        }
        controller.close()
      },
    })
    const chunks = []
    for await (const chunk of parseGoogleSseStream(body)) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([{ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }])
  })
  test.each(['low', 'medium', 'high'])('原生 %s 强度直接映射且不附带 budget', (reasoningEffort) => {
    const result = buildGoogleRequestParams({
      ...params,
      reasoningEffort,
      thinking: { type: 'enabled', budgetTokens: 1024 },
      temperature: 0.3,
      topP: 0.8,
    })
    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: reasoningEffort.toUpperCase(),
      includeThoughts: true,
    })
    expect(result.generationConfig?.temperature).toBeUndefined()
    expect(result.generationConfig?.topP).toBeUndefined()
  })
  test('关闭展示思考不会向强制思考模型发送无效 budget 0', () => {
    expect(
      buildGoogleRequestParams({ ...params, thinking: { type: 'disabled' } }).generationConfig
        ?.thinkingConfig,
    ).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: false })
  })
  test('工具调用签名在非流式响应和后续消息之间往返', () => {
    const response = googleResponseToStandard(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'Read', args: { path: 'a.ts' } },
                  thoughtSignature: 'fixture-signature',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      params.model,
    )
    expect(messagesToGoogle([{ ...response }]).contents[0]?.parts[0]?.thoughtSignature).toBe(
      'fixture-signature',
    )
  })
  test('中立工具结果恢复原始函数名，并保留调用关联 ID', () => {
    const result = messagesToGoogle([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'fixture-call', name: 'echo', input: { value: 'OK' } }],
      },
      { role: 'tool', toolCallId: 'fixture-call', content: 'OK' },
    ])
    expect(result.contents[1]?.parts[0]?.functionResponse).toEqual({
      name: 'echo',
      id: 'fixture-call',
      response: { output: 'OK' },
    })
    const inlineResult = messagesToGoogle([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'fixture-call', name: 'echo', input: { value: 'OK' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'fixture-call', content: 'OK' }],
      },
    ])
    expect(inlineResult.contents[1]?.parts[0]?.functionResponse?.name).toBe('echo')
  })
  test('原生 SSE 支持跨 UTF-8 字节切片并取消未消费连接', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}\r\n\r\n',
    )
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]))
        }
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const chunk of parseGoogleSseStream(body)) {
      expect(chunk.candidates?.[0]?.content?.parts[0]?.text).toBe('你好')
      break
    }
    expect(cancelled).toBe(true)
  })
  test('错误和损坏 SSE 不能静默当作成功', async () => {
    for (const payload of ['{"error":{"code":429,"message":"rate limit"}}', '{broken']) {
      const read = async () => {
        for await (const _chunk of parseGoogleSseStream(new Response(`data: ${payload}\n`).body!)) {
        }
      }
      await expect(read()).rejects.toThrow()
    }
  })
})
