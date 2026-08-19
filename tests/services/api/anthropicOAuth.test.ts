import { describe, expect, mock, test } from 'bun:test'
import type { CreateParams } from '../../../src/types/llm.js'
import {
  buildAnthropicOAuthRequestParams,
  getAnthropicOAuthClient,
} from '../../../src/services/api/anthropicProviderAdapter.js'

function createParams(): CreateParams {
  return {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxTokens: 128,
    system: 'Project instructions',
  }
}

describe('Anthropic 订阅 OAuth 通道', () => {
  test('使用 Bearer 而不是 x-api-key，并携带 OAuth beta headers', async () => {
    let requestUrl = ''
    let requestHeaders = new Headers()
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const client = getAnthropicOAuthClient({
      accessToken: 'sk-ant-oat-test',
      fetch: fetchMock,
      userAgent: 'claude-cli/test',
    })

    const request = buildAnthropicOAuthRequestParams({
      ...createParams(),
      providerExtras: {
        anthropic: { betas: ['interleaved-thinking-2025-05-14'] },
      },
    })
    await client.beta.messages.create({ ...request, stream: false })

    expect(requestUrl).toStartWith('https://api.anthropic.com/v1/messages')
    expect(requestHeaders.get('authorization')).toBe('Bearer sk-ant-oat-test')
    expect(requestHeaders.get('x-api-key')).toBeNull()
    expect(requestHeaders.get('anthropic-beta')).toContain('claude-code-20250219')
    expect(requestHeaders.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(requestHeaders.get('anthropic-beta')).toContain('interleaved-thinking-2025-05-14')
  })

  test('OAuth 请求将 Claude Code 身份置于用户 system prompt 之前', () => {
    const request = buildAnthropicOAuthRequestParams(createParams())

    expect(request.system).toEqual([
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: 'Project instructions' },
    ])
  })
})
