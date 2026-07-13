/**
 * OpenAI Provider Adapter — 唯一与 openai SDK 客户端交互的入口。
 *
 * 所有标准格式 ↔ OpenAI 格式的转换都委托给 conversions/openai.ts。
 * 客户端创建统一走 client.ts 的 getOpenAIClient()，与 Anthropic 路径共享
 * headers/baseUrl/proxy/debug 等基础设施。
 */

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { getMainLoopModel, normalizeModelStringForAPI } from '../../services/model/model.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { createDebugLog } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { countMessagesTokensLocally } from '../tokenEstimation.js'
import { getOpenAIClient } from './client.js'
import {
  buildOpenAIRequestParams,
  mapOpenAIStreamToStandard,
  type OpenAICreateParams,
  openAIResponseToStandard,
} from './conversions/openai.js'

const log = createDebugLog('openai')

export class OpenAIProviderAdapter implements LLMAdapter {
  readonly name = 'openai'

  /**
   * 可选注入的 client（测试或外部复用场景）。
   * 未注入时通过 getOpenAIClient 懒加载。
   */
  private readonly injectedClient: OpenAI | null

  constructor(client?: OpenAI) {
    this.injectedClient = client ?? null
  }

  private async getClient(model?: string): Promise<OpenAI> {
    if (this.injectedClient) {
      return this.injectedClient
    }
    return getOpenAIClient({ model })
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient(params.model)
    const requestParams = buildOpenAIRequestParams(params)
    log(
      `Streaming request: model=${params.model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )
    log(
      `Streaming request params summary: ${jsonStringify({
        model: requestParams.model,
        messagesCount: (requestParams.messages as unknown[] | undefined)?.length ?? 0,
        toolsCount: (requestParams.tools as unknown[] | undefined)?.length ?? 0,
        enable_search: requestParams.enable_search,
        search_options: requestParams.search_options,
        stream: true,
      })}`,
    )

    const stream = (await client.chat.completions.create(
      {
        ...requestParams,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    return {
      stream: mapOpenAIStreamToStandard(stream, params.model),
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
    const requestParams = buildOpenAIRequestParams(params)
    log(
      `Non-streaming request: model=${params.model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )
    log(
      `Non-streaming request params summary: ${jsonStringify({
        model: requestParams.model,
        messagesCount: (requestParams.messages as unknown[] | undefined)?.length ?? 0,
        toolsCount: (requestParams.tools as unknown[] | undefined)?.length ?? 0,
        enable_search: requestParams.enable_search,
        search_options: requestParams.search_options,
        stream: false,
      })}`,
    )

    const completion = await client.chat.completions.create(
      {
        ...requestParams,
        stream: false,
      },
      { signal },
    )

    return openAIResponseToStandard(completion, params.model)
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = getMainLoopModel() ?? ''
      const normalizedModel = normalizeModelStringForAPI(model)
      return countMessagesTokensLocally(messages, tools, normalizedModel)
    } catch (error) {
      log(`countTokens error: ${error}`)
      return null
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const model = getMainLoopModel() ?? ''
      const client = await getOpenAIClient({ apiKey, maxRetries: 3, model })
      const verifyParams: OpenAICreateParams = {
        model: normalizeModelStringForAPI(model),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
        thinking: { type: 'disabled' },
      }
      await client.chat.completions.create(verifyParams)
      return true
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) {
        return false
      }
      if (
        error instanceof Error &&
        /invalid|unauthorized|authentication|api.key/i.test(error.message)
      ) {
        return false
      }
      throw error
    }
  }
}
