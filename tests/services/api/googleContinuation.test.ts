import { describe, expect, test } from 'bun:test'
import { VertexGoogleProviderAdapter } from '../../../src/services/api/vertexGoogleProviderAdapter.js'
import {
  buildGoogleRequestParams,
  googleResponseToStandard,
  googleStreamToStandard,
  messagesToGoogle,
  type GoogleGenerateContentRequest,
  type GoogleGenerateContentResponse,
} from '../../../src/services/api/conversions/google.js'
import { GoogleContinuationState } from '../../../src/services/api/googleContinuation.js'
import { getTokenCountFromUsage } from '../../../src/services/api/tokens.js'
import { updateUsage } from '../../../src/services/api/usageTracker.js'
import { EMPTY_USAGE } from '../../../src/services/api/emptyUsage.js'
import type { CreateParams, LLMStreamEvent } from '../../../src/types/llm.js'

const params: CreateParams = {
  model: 'gemini-4-argon',
  maxTokens: 49152,
  system: 'Fixture system instruction.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Run a fixture.' }] }],
  tools: [
    { name: 'echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
  ],
}
const target = {
  baseUrl:
    'https://aiplatform.googleapis.com/v1beta1/projects/fixture/locations/global/publishers/google',
  project: 'fixture',
  location: 'global',
  headers: new Headers(),
}

function fixture(responses: GoogleGenerateContentResponse[][], streaming: boolean) {
  const requests: GoogleGenerateContentRequest[] = []
  const adapter = new VertexGoogleProviderAdapter({
    resolveContext: async () => target,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)))
      const chunks = responses[requests.length - 1]
      if (!chunks) {
        throw new Error('Unexpected extra request')
      }
      return streaming
        ? new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''))
        : Response.json(chunks[0])
    },
  })
  return { adapter, requests }
}

async function collect(stream: AsyncIterable<LLMStreamEvent>) {
  const events: LLMStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

const checkpoint: GoogleGenerateContentResponse = {
  responseId: 'fixture-response',
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ thought: true, text: 'summary', thoughtSignature: 'thinking-signature' }],
      },
      finishReason: 'CONTINUATION',
      continuationToken: 'fixture-checkpoint',
    },
  ],
  usageMetadata: {
    promptTokenCount: 100,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 10,
    cachedContentTokenCount: 60,
  },
}
const completed: GoogleGenerateContentResponse = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call-1', name: 'echo', args: { value: 'OK' } },
            thoughtSignature: 'tool-signature',
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 120,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 2,
    cachedContentTokenCount: 100,
  },
}

describe('Vertex Gemini 原生续传', () => {
  test.each([
    true,
    false,
  ])('仅思考检查点仍续传，原始输入与预算不变，签名和用量保留：stream=%s', async (streaming) => {
    const { adapter, requests } = fixture([[checkpoint], [completed]], streaming)
    if (streaming) {
      const { stream } = await adapter.createStream(params, new AbortController().signal)
      const events = await collect(stream)
      expect(events.filter((event) => event.type === 'response_start')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'response_stop')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'response_delta')).toHaveLength(1)
      expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
        stopReason: 'tool_use',
        usage: {
          inputTokens: 220,
          outputTokens: 17,
          cacheReadInputTokens: 160,
          extras: { initialPromptTokenCount: 100, thoughtsTokenCount: 12 },
        },
      })
      expect(
        events.find((event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call'),
      ).toMatchObject({
        chunk: {
          providerMetadata: {
            googleThoughtSignature: 'tool-signature',
            googleFunctionCallId: 'call-1',
          },
        },
      })
    } else {
      const response = await adapter.createMessage(params, new AbortController().signal)
      expect(response.id).toBe('fixture-response')
      expect(response.stopReason).toBe('tool_use')
      expect(response.usage).toMatchObject({
        inputTokens: 220,
        outputTokens: 17,
        cacheReadInputTokens: 160,
        extras: { initialPromptTokenCount: 100 },
      })
      expect(getTokenCountFromUsage(response.usage)).toBe(117)
      const history = messagesToGoogle([{ role: 'assistant', content: response.content }])
      expect(history.contents[0]?.parts.map((part) => part.thoughtSignature)).toEqual([
        'thinking-signature',
        'tool-signature',
      ])
    }
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({ ...requests[0], continuationToken: 'fixture-checkpoint' })
    expect(requests[1]?.generationConfig?.maxOutputTokens).toBe(49152)
    expect(params.messages).toHaveLength(1)
  })

  test.each([true, false])('MAX_TOKENS 携带令牌也不提额或继续：stream=%s', async (streaming) => {
    const { adapter, requests } = fixture(
      [
        [
          {
            candidates: [
              {
                content: { parts: [{ text: 'partial' }] },
                finishReason: 'MAX_TOKENS',
                continuationToken: 'must-not-use',
              },
            ],
          },
        ],
      ],
      streaming,
    )
    if (streaming) {
      const events = await collect(
        (await adapter.createStream(params, new AbortController().signal)).stream,
      )
      expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
        stopReason: 'max_tokens',
      })
    } else {
      expect((await adapter.createMessage(params, new AbortController().signal)).stopReason).toBe(
        'max_tokens',
      )
    }
    expect(requests).toHaveLength(1)
  })

  test.each([true, false])('缺失和重复令牌不会无限请求：stream=%s', async (streaming) => {
    for (const missing of [true, false]) {
      const response = structuredClone(checkpoint)
      if (missing) {
        delete response.candidates![0]!.continuationToken
      }
      const { adapter, requests } = fixture([[response], [response]], streaming)
      const consume = async () =>
        streaming
          ? collect((await adapter.createStream(params, new AbortController().signal)).stream)
          : adapter.createMessage(params, new AbortController().signal)
      await expect(consume()).rejects.toMatchObject({ status: 400 })
      expect(requests).toHaveLength(missing ? 1 : 2)
    }
  })

  test('检查点前的工具必须等最终 STOP 才可执行', async () => {
    const first = structuredClone(completed)
    first.candidates![0]!.finishReason = 'CONTINUATION'
    first.candidates![0]!.continuationToken = 'fixture-token'
    let executedBeforeContinuation = false
    let calls = 0
    const events: LLMStreamEvent[] = []
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => {
        if (calls++ === 1) {
          executedBeforeContinuation = events.some(
            (event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call',
          )
        }
        const chunk = calls === 1 ? first : { candidates: [{ finishReason: 'STOP' }] }
        return new Response(`data: ${JSON.stringify(chunk)}\n\n`)
      },
    })
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    for await (const event of stream) {
      events.push(event)
    }
    expect(executedBeforeContinuation).toBe(false)
    expect(
      events.filter((event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call'),
    ).toHaveLength(1)
  })

  test('跨检查点的独立思考签名不拼接，也不把后续增量写入已签名 Part', async () => {
    const first = structuredClone(checkpoint)
    const second = structuredClone(checkpoint)
    second.candidates![0]!.continuationToken = 'second-checkpoint'
    second.candidates![0]!.content!.parts[0]!.thoughtSignature = 'second-signature'
    const { adapter } = fixture(
      [
        [first],
        [second],
        [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
      ],
      true,
    )
    const events = await collect(
      (await adapter.createStream(params, new AbortController().signal)).stream,
    )
    expect(
      events.filter((event) => event.type === 'chunk_start' && event.chunk.type === 'thinking'),
    ).toHaveLength(2)
    expect(
      events.flatMap((event) =>
        event.type === 'chunk_delta' && event.delta.type === 'signature_delta' ? [event.delta] : [],
      ),
    ).toEqual([
      { type: 'signature_delta', signature: 'thinking-signature' },
      { type: 'signature_delta', signature: 'second-signature' },
    ])
  })

  test.each([true, false])('取消后不再发起下一段：stream=%s', async (streaming) => {
    const controller = new AbortController()
    let calls = 0
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => {
        calls++
        controller.abort()
        return streaming
          ? new Response(`data: ${JSON.stringify(checkpoint)}\n\n`)
          : Response.json(checkpoint)
      },
    })
    await expect(
      (async () =>
        streaming
          ? collect((await adapter.createStream(params, controller.signal)).stream)
          : adapter.createMessage(params, controller.signal))(),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('v1 长输出在发送前提示需要 v1beta1，不偷偷降低预算', async () => {
    let calls = 0
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => ({ ...target, baseUrl: target.baseUrl.replace('v1beta1', 'v1') }),
      fetch: async () => {
        calls++
        return Response.json({})
      },
    })
    await expect(adapter.createMessage(params, new AbortController().signal)).rejects.toMatchObject(
      { status: 400 },
    )
    expect(calls).toBe(0)
  })

  test('断线前未结束的检查点不直接重放，避免重复正文和工具', async () => {
    let calls = 0
    let reads = 0
    const adapter = new VertexGoogleProviderAdapter({
      resolveContext: async () => target,
      fetch: async () => {
        calls++
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads++ === 0) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"continuationToken":"checkpoint-before-drop"}]}\n\n',
                  ),
                )
              } else {
                controller.error(
                  Object.assign(new Error('socket closed'), { code: 'ConnectionClosed' }),
                )
              }
            },
          }),
        )
      },
    })
    const events: LLMStreamEvent[] = []
    const { stream } = await adapter.createStream(params, new AbortController().signal)
    await expect(
      (async () => {
        for await (const event of stream) {
          events.push(event)
        }
      })(),
    ).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(calls).toBe(1)
    expect(events.some((event) => event.type === 'response_stop')).toBe(false)
  })

  test('分段累计快照及单独用量尾包只统计一次，并保留上下文基数', () => {
    const state = new GoogleContinuationState(100)
    state.update({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } })
    state.update({ usageMetadata: { candidatesTokenCount: 2 } })
    state.finish({ finishReason: 'CONTINUATION', continuationToken: 'a' })
    state.update({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 } })
    const result = state.update({ usageMetadata: { thoughtsTokenCount: 4 } })
    expect(result.usageMetadata).toEqual({
      promptTokenCount: 30,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 4,
      initialPromptTokenCount: 10,
    })
    const response = googleResponseToStandard(
      { ...result, candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
      params.model,
    )
    const usage = updateUsage(EMPTY_USAGE, response.usage)
    expect(usage.inputTokens).toBe(30)
    expect(usage.outputTokens).toBe(9)
    expect(usage.extras?.initialPromptTokenCount).toBe(10)
    expect(getTokenCountFromUsage(usage)).toBe(19)
  })

  test.each([
    'MAX_TOKENS',
    'MALFORMED_FUNCTION_CALL',
    'SAFETY',
    undefined,
  ])('非流式未成功工具调用不能执行：%s', (finishReason) => {
    const response = structuredClone(completed)
    response.candidates![0]!.finishReason = finishReason
    expect(() => googleResponseToStandard(response, params.model)).toThrow()
  })

  test('非流式参数片段不能当作完整工具执行', () => {
    const response = structuredClone(completed)
    response.candidates![0]!.content!.parts[0]!.functionCall!.partialArgs = []
    expect(() => googleResponseToStandard(response, params.model)).toThrow()
  })

  test('未处理的续传不能被共享转换层伪装为成功', async () => {
    expect(() => googleResponseToStandard(checkpoint, params.model)).toThrow()
    async function* chunks() {
      yield checkpoint
    }
    await expect(collect(googleStreamToStandard(chunks(), params.model, 'delta'))).rejects.toThrow()
  })

  test('未知停止原因不能伪装正常结束', async () => {
    const response: GoogleGenerateContentResponse = {
      candidates: [
        { content: { parts: [{ text: 'partial' }] }, finishReason: 'NEW_UNKNOWN_REASON' },
      ],
    }
    expect(() => googleResponseToStandard(response, params.model)).toThrow()
    async function* chunks() {
      yield response
    }
    await expect(collect(googleStreamToStandard(chunks(), params.model, 'delta'))).rejects.toThrow()
  })

  test('带 models 前缀仍使用 4 系列配置，不修改冻结的显式思考参数', () => {
    const thinkingConfig = Object.freeze({
      thinkingBudget: 1024,
      thinkingLevel: 'HIGH',
      includeThoughts: false,
    })
    const request = buildGoogleRequestParams({
      ...params,
      model: 'models/gemini-4-argon',
      maxTokens: 131072,
      providerExtras: { google: { thinkingConfig } },
    })
    expect(request.generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
      includeThoughts: false,
    })
    expect(request.generationConfig?.maxOutputTokens).toBe(131072)
    expect(thinkingConfig.thinkingBudget).toBe(1024)
  })
})
