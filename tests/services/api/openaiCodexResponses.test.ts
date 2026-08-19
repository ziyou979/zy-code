import { describe, expect, mock, test } from 'bun:test'
import OpenAI from 'openai'
import type { CreateParams } from '../../../src/types/llm.js'
import {
  buildOpenAICodexRequestParams,
  getOpenAICodexClient,
  OpenAICodexResponsesProviderAdapter,
} from '../../../src/services/api/openAICodexResponsesProviderAdapter.js'

function createParams(): CreateParams {
  return {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxTokens: 1024,
  }
}

function createAccessToken(accountId: string): string {
  const payload = btoa(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  )
  return `header.${payload}.signature`
}

describe('OpenAI Codex Responses 订阅通道', () => {
  test('请求使用 Codex backend 约束而不是普通 API Platform 参数', () => {
    const request = buildOpenAICodexRequestParams(createParams(), true)

    expect(request).toMatchObject({
      model: 'gpt-5.3-codex',
      store: false,
      stream: true,
      instructions: 'You are a helpful assistant.',
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      text: { verbosity: 'low' },
    })
    expect(request.max_output_tokens).toBeUndefined()
    expect(request.top_p).toBeUndefined()
    expect(request.temperature).toBeUndefined()
  })

  test('Codex 工具显式关闭 strict，兼容项目内的宽松 schema', () => {
    const request = buildOpenAICodexRequestParams(
      {
        ...createParams(),
        tools: [
          {
            name: 'search',
            description: 'Search',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      },
      true,
    )

    expect(request.tools?.[0]).toMatchObject({ type: 'function', strict: null })
  })

  test('客户端发送到订阅端点并携带账户 header', async () => {
    let requestUrl = ''
    let requestHeaders = new Headers()
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'gpt-5.3-codex',
          output: [],
          parallel_tool_calls: true,
          tool_choice: 'auto',
          tools: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const client = await getOpenAICodexClient({
      apiKey: createAccessToken('account-test'),
      fetch: fetchMock,
      userAgent: 'zy-code-test',
    })

    await client.responses.create({ model: 'gpt-5.3-codex', input: 'test', store: false })

    expect(requestUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(requestHeaders.get('authorization')).toStartWith('Bearer ')
    expect(requestHeaders.get('chatgpt-account-id')).toBe('account-test')
    expect(requestHeaders.get('originator')).toBe('zy-code')
    expect(requestHeaders.get('openai-beta')).toBe('responses=experimental')
  })

  test('response.done 会归一化并结束标准事件流', async () => {
    async function* events(): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
      yield {
        type: 'response.created',
        response: { id: 'resp_test', model: 'gpt-5.3-codex' },
      } as unknown as OpenAI.Responses.ResponseStreamEvent
      yield {
        type: 'response.output_text.delta',
        delta: 'ok',
        item_id: 'item_1',
        output_index: 0,
        content_index: 0,
      } as OpenAI.Responses.ResponseStreamEvent
      yield {
        type: 'response.done',
        response: {
          id: 'resp_test',
          model: 'gpt-5.3-codex',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      } as unknown as OpenAI.Responses.ResponseStreamEvent
    }

    const create = mock(async (_request: unknown) => events())
    const client = { responses: { create } } as unknown as OpenAI
    const adapter = new OpenAICodexResponsesProviderAdapter(client)
    const result = await adapter.createStream(createParams(), new AbortController().signal)
    const output = []
    for await (const event of result.stream) {
      output.push(event)
    }

    expect(output.some((event) => event.type === 'response_stop')).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  test('非流式上层调用仍通过 SSE 获取并组装完整响应', async () => {
    async function* events(): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
      yield {
        type: 'response.done',
        response: {
          id: 'resp_message',
          model: 'gpt-5.3-codex',
          status: 'completed',
          output: [
            {
              id: 'item_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      } as unknown as OpenAI.Responses.ResponseStreamEvent
    }

    const create = mock(async (_request: unknown) => events())
    const client = { responses: { create } } as unknown as OpenAI
    const adapter = new OpenAICodexResponsesProviderAdapter(client)
    const response = await adapter.createMessage(createParams(), new AbortController().signal)

    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true })
  })
})
