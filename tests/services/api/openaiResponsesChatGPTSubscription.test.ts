import { describe, expect, mock, test } from 'bun:test'
import OpenAI from 'openai'
import {
  buildResponsesRequestParams,
  mapResponsesStreamToStandard,
} from '../../../src/services/api/conversions/openaiResponses.js'
import { OpenAIResponsesProviderAdapter } from '../../../src/services/api/openAIResponsesProviderAdapter.js'
import {
  categorizeRetryableAPIError,
  getAPIErrorSeverity,
} from '../../../src/services/api/errors.js'
import type { CreateParams } from '../../../src/types/llm.js'

/** 最小可用的 CreateParams。 */
function baseParams(): CreateParams {
  return {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 4096,
    temperature: 0.7,
  }
}

describe('ChatGPT 订阅请求裁剪', () => {
  test('API key 请求保留 max_output_tokens 与 temperature', () => {
    const out = buildResponsesRequestParams(baseParams())
    expect(out.max_output_tokens).toBe(4096)
    expect(out.temperature).toBe(0.7)
  })

  test('订阅令牌请求省略端点不接受的字段', () => {
    const out = buildResponsesRequestParams(baseParams(), { chatGPTSubscription: true })
    expect(out.max_output_tokens).toBeUndefined()
    expect(out.temperature).toBeUndefined()
  })

  test('订阅请求裁剪缓存保留时间但保留缓存标识', () => {
    const params = baseParams()
    params.providerExtras = {
      openai: {
        prompt_cache_key: 'session-1',
        prompt_cache_retention: '24h',
        store: false,
      },
    }
    const out = buildResponsesRequestParams(params, { chatGPTSubscription: true })
    const record = out as unknown as Record<string, unknown>
    expect(record.prompt_cache_key).toBe('session-1')
    expect(record.prompt_cache_retention).toBeUndefined()
    // 非受限字段仍应透传
    expect(record.store).toBe(false)
  })

  test('extraBody 无法绕过订阅约束，普通 API key 仍完整透传', () => {
    const extraBody = {
      max_output_tokens: 10,
      temperature: 0.4,
      top_p: 0.9,
      prompt_cache_retention: '24h',
      previous_response_id: 'resp_old',
      background: true,
      metadata: { label: 'test' },
      store: true,
    }
    const params = { ...baseParams(), extraBody }
    const subscription = buildResponsesRequestParams(params, { chatGPTSubscription: true })
    for (const field of Object.keys(extraBody).filter((key) => key !== 'store')) {
      expect(subscription).not.toHaveProperty(field)
    }
    expect(subscription.store).toBe(false)
    expect(Array.isArray(subscription.input)).toBe(true)
    expect(buildResponsesRequestParams(params)).toMatchObject(extraBody)
  })
})

describe('OpenAIResponsesProviderAdapter 订阅传输', () => {
  function sseResponse(events: unknown[]): Response {
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const completed = {
    type: 'response.completed',
    response: {
      id: 'resp_test',
      status: 'completed',
      model: 'gpt-5.6-sol',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  }

  test('流式和非流式业务都发送 Bearer 与 SSE，并组装完整响应', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const client = new OpenAI({
      apiKey: 'subscription-token',
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return sseResponse([completed])
      },
    })
    const adapter = new OpenAIResponsesProviderAdapter(client, { chatGPTSubscription: true })
    const signal = new AbortController().signal
    const response = await adapter.createMessage(baseParams(), signal)
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    const result = await adapter.createStream(baseParams(), signal)
    const output = []
    for await (const event of result.stream) {
      output.push(event)
    }
    expect(output.at(-1)?.type).toBe('response_stop')
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe('https://api.openai.com/v1/responses')
      expect(request.headers.get('authorization')).toBe('Bearer subscription-token')
      expect(request.body).toMatchObject({ stream: true, store: false })
      expect(request.body).not.toHaveProperty('max_output_tokens')
    }
  })

  test('普通 API key 非流式请求仍使用 JSON 响应和原参数', async () => {
    const create = mock(async (_request: unknown) => completed.response)
    const adapter = new OpenAIResponsesProviderAdapter({
      responses: { create },
    } as unknown as OpenAI)
    await adapter.createMessage(baseParams(), new AbortController().signal)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: false,
      max_output_tokens: 4096,
      temperature: 0.7,
    })
  })

  test('订阅流失败保留错误码，普通错误文案也能触发正确的重试分类', async () => {
    for (const code of [
      'subscription_sharing_usage_limit_exceeded',
      'subscription_sharing_usage_unavailable',
    ]) {
      const client = new OpenAI({
        apiKey: 'subscription-token',
        fetch: async () =>
          sseResponse([
            { type: 'response.failed', response: { error: { code, message: 'Request failed' } } },
          ]),
      })
      const adapter = new OpenAIResponsesProviderAdapter(client, { chatGPTSubscription: true })
      const signal = new AbortController().signal
      const result = await adapter.createStream(baseParams(), signal)
      const streamError = await (async () => {
        for await (const _event of result.stream) {
          /* 消费流以触发终止错误。 */
        }
      })().catch((error: unknown) => error)
      const messageError = await adapter
        .createMessage(baseParams(), signal)
        .catch((error: unknown) => error)
      for (const error of [streamError, messageError]) {
        expect(error).toBeInstanceOf(Error)
        expect(getAPIErrorSeverity(error)).toBe(
          code.endsWith('exceeded') ? 'terminal' : 'retryable',
        )
      }
    }
  })

  test('订阅断流不能伪装成成功', async () => {
    async function* empty(): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {}
    const collect = async () => {
      for await (const _event of mapResponsesStreamToStandard(empty(), 'test', {
        requireTerminalEvent: true,
      })) {
        /* 等待终止事件。 */
      }
    }
    await expect(collect()).rejects.toThrow('terminal response')
  })
})

describe('ChatGPT 订阅错误分类', () => {
  const limitMessage =
    '{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"usage limit exceeded"}}'

  test('订阅超限不重试，即使状态码是 429', () => {
    const error = Object.assign(new Error(limitMessage), { status: 429 })
    // 配额按窗口重置，退避重试只会耗尽重试次数
    expect(getAPIErrorSeverity(error)).toBe('terminal')
  })

  test('订阅超限归类为 rate_limit', () => {
    const error = Object.assign(new Error(limitMessage), { status: 429 })
    expect(categorizeRetryableAPIError(error)).toBe('rate_limit')
  })

  test('订阅侧临时不可用可重试', () => {
    for (const code of [
      'subscription_sharing_usage_unavailable',
      'subscription_sharing_user_unavailable',
    ]) {
      const error = Object.assign(new Error(`{"error":{"code":"${code}"}}`), { status: 503 })
      expect(getAPIErrorSeverity(error)).toBe('retryable')
      expect(categorizeRetryableAPIError(error)).toBe('server_error')
    }
  })

  test('普通 429 仍按原逻辑可重试，不受影响', () => {
    const error = Object.assign(new Error('rate limit exceeded'), { status: 429 })
    expect(getAPIErrorSeverity(error)).toBe('retryable')
  })

  test('订阅准入被拒（套餐/策略/能力不支持）不重试', () => {
    for (const code of [
      'subscription_sharing_user_not_eligible',
      'subscription_sharing_unsupported_capability',
      'subscription_sharing_route_not_supported',
      'chatpass_v2_scope_not_authorized',
      'subscription_sharing_invalid_user',
    ]) {
      const error = Object.assign(new Error(`{"error":{"code":"${code}"}}`), { status: 403 })
      // 权限/能力问题，重试或改换计费都无济于事
      expect(getAPIErrorSeverity(error)).toBe('terminal')
      expect(categorizeRetryableAPIError(error)).toBe('authentication_failed')
    }
  })
})
