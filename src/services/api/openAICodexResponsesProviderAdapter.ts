/**
 * ChatGPT Codex 订阅 Responses 适配器。
 *
 * 请求和事件结构与 OpenAI Responses 接近，但鉴权端点、必要 header 以及
 * body 约束不同。转换逻辑继续复用 openaiResponses.ts，协议差异集中在此处。
 */

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import {
  getAuthProfileForModel,
  getMainLoopModel,
  getProviderForModel,
  normalizeModelStringForAPI,
} from '../model/model.js'
import { getApiKey } from '../auth/auth.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { countMessagesTokensLocally } from '../tokenEstimation.js'
import { getUserAgent } from '../http/http.js'
import { buildProxiedFetch } from '../http/proxy.js'
import { getOpenAICodexAccountId } from '../oauth/providers/openaiCodex.js'
import {
  buildResponsesRequestParams,
  mapResponsesStreamToStandard,
  responsesToStandard,
  type ResponsesCreateParams,
} from './conversions/openaiResponses.js'

const log = createDebugLog('openai-codex-responses')
const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** 创建仅供 ChatGPT Codex 订阅协议使用的客户端。 */
export async function getOpenAICodexClient(options: {
  apiKey: string
  baseURL?: string
  timeout?: number
  maxRetries?: number
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  userAgent?: string
}): Promise<OpenAI> {
  const accountId = getOpenAICodexAccountId(options.apiKey)
  if (!accountId) {
    throw new Error('Failed to extract accountId from OpenAI Codex OAuth token')
  }

  const proxyFetch = buildProxiedFetch()
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? OPENAI_CODEX_BASE_URL,
    timeout: options.timeout ?? parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    maxRetries: options.maxRetries ?? 0,
    defaultHeaders: {
      'chatgpt-account-id': accountId,
      originator: 'zy-code',
      'OpenAI-Beta': 'responses=experimental',
      'User-Agent': options.userAgent ?? getUserAgent(),
      'X-Zy-Code-Session-Id': getSessionId(),
    },
    ...(options.fetch ? { fetch: options.fetch } : proxyFetch ? { fetch: proxyFetch } : {}),
  })
}

/** 按 pi 的 Codex SSE 协议收窄普通 Responses 请求。 */
export function buildOpenAICodexRequestParams(
  params: CreateParams,
  stream: boolean,
): ResponsesCreateParams {
  const request = buildResponsesRequestParams(params)

  // Codex backend 自行管理输出预算；普通 API 的 max_output_tokens 会被拒绝。
  delete request.max_output_tokens
  delete request.top_p
  if (params.temperature === undefined) {
    delete request.temperature
  }

  request.store = false
  request.stream = stream
  request.instructions ??= 'You are a helpful assistant.'
  request.include = ['reasoning.encrypted_content']
  request.tool_choice ??= 'auto'
  request.parallel_tool_calls = true
  if (Array.isArray(request.tools)) {
    request.tools = request.tools.map((tool) =>
      tool.type === 'function'
        ? ({ ...tool, strict: null } as unknown as OpenAI.Responses.Tool)
        : tool,
    )
  }
  const textConfig =
    typeof request.text === 'object' && request.text !== null
      ? (request.text as unknown as Record<string, unknown>)
      : {}
  ;(request as unknown as Record<string, unknown>).text = {
    verbosity: 'low',
    ...textConfig,
  }
  return request
}

/** Codex 使用 response.done 作为完成事件时，归一化为公开 Responses 事件名。 */
async function* normalizeCodexEvents(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
  for await (const event of stream) {
    const raw = event as unknown as Record<string, unknown>
    if (raw.type === 'error') {
      const nested =
        typeof raw.error === 'object' && raw.error !== null
          ? (raw.error as Record<string, unknown>)
          : undefined
      const message =
        typeof raw.message === 'string'
          ? raw.message
          : typeof nested?.message === 'string'
            ? nested.message
            : 'OpenAI Codex subscription request failed'
      throw new Error(message)
    }
    if (raw.type === 'response.failed') {
      const response =
        typeof raw.response === 'object' && raw.response !== null
          ? (raw.response as Record<string, unknown>)
          : undefined
      const error =
        typeof response?.error === 'object' && response.error !== null
          ? (response.error as Record<string, unknown>)
          : undefined
      throw new Error(
        typeof error?.message === 'string'
          ? error.message
          : 'OpenAI Codex subscription response failed',
      )
    }
    if (raw.type === 'response.done') {
      yield {
        ...raw,
        type: 'response.completed',
      } as unknown as OpenAI.Responses.ResponseStreamEvent
      return
    }
    yield event
  }
}

/** Codex backend 仅提供 SSE；非流式调用在客户端消费完成事件后再返回标准响应。 */
async function consumeCodexResponse(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): Promise<OpenAI.Responses.Response> {
  for await (const event of stream) {
    const raw = event as unknown as Record<string, unknown>
    if (
      raw.type === 'response.done' ||
      raw.type === 'response.completed' ||
      raw.type === 'response.incomplete'
    ) {
      const response = raw.response
      if (typeof response === 'object' && response !== null) {
        return response as OpenAI.Responses.Response
      }
    }
    if (raw.type === 'response.failed' || raw.type === 'error') {
      const message =
        typeof raw.message === 'string' ? raw.message : 'OpenAI Codex subscription request failed'
      throw new Error(message)
    }
  }
  throw new Error('OpenAI Codex subscription stream ended without a completed response')
}

export class OpenAICodexResponsesProviderAdapter implements LLMAdapter {
  readonly name = 'openai-codex-responses'
  private readonly injectedClient: OpenAI | null

  constructor(client?: OpenAI) {
    this.injectedClient = client ?? null
  }

  private async getClient(model: string): Promise<OpenAI> {
    if (this.injectedClient) {
      return this.injectedClient
    }
    return getOpenAICodexClient({ apiKey: this.getAccessToken(model) })
  }

  private getAccessToken(model: string): string {
    const connectionId = getAuthProfileForModel(model) ?? getProviderForModel(model)
    const token = getApiKey(connectionId)
    if (!token) {
      throw new Error('OpenAI Codex OAuth token is unavailable')
    }
    return token
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient(params.model)
    const request = buildOpenAICodexRequestParams(params, true)
    log(`Streaming subscription request: model=${params.model}`)

    const stream = (await client.responses.create(request as never, {
      signal,
    })) as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>

    return {
      stream: mapResponsesStreamToStandard(normalizeCodexEvents(stream), params.model),
      requestId: randomUUID(),
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient(params.model)
    const stream = (await client.responses.create(
      buildOpenAICodexRequestParams(params, true) as never,
      { signal },
    )) as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
    return responsesToStandard(await consumeCodexResponse(stream), params.model)
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = normalizeModelStringForAPI(getMainLoopModel() ?? '')
      return countMessagesTokensLocally(messages, tools, model)
    } catch (error) {
      log(`countTokens error: ${error}`)
      return null
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const client = await getOpenAICodexClient({ apiKey, maxRetries: 0 })
      const model = normalizeModelStringForAPI(getMainLoopModel() ?? '')
      const stream = (await client.responses.create({
        ...buildOpenAICodexRequestParams({ model, messages: [], maxTokens: 1 }, true),
        input: 'test',
      } as never)) as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
      await consumeCodexResponse(stream)
      return true
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        return false
      }
      if (
        error instanceof Error &&
        /invalid|unauthorized|authentication|accountId/i.test(error.message)
      ) {
        return false
      }
      throw error
    }
  }
}
