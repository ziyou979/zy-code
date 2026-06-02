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
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { countMessagesTokensLocally } from '../tokenEstimation.js'
import { getOpenAIClient } from './client.js'
import {
  buildOpenAIRequestParams,
  mapOpenAIStreamToStandard,
  openAIResponseToStandard,
} from './conversions/openai.js'

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

  private async getClient(): Promise<OpenAI> {
    if (this.injectedClient) {
      return this.injectedClient
    }
    return getOpenAIClient()
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient()
    const requestParams = buildOpenAIRequestParams(params)
    logForDebugging(
      `[OpenAI] Streaming request: model=${params.model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )
    logForDebugging(
      `[OpenAI] Streaming request params summary: ${jsonStringify({
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
    const client = await this.getClient()
    const requestParams = buildOpenAIRequestParams(params)
    logForDebugging(
      `[OpenAI] Non-streaming request: model=${params.model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )
    logForDebugging(
      `[OpenAI] Non-streaming request params summary: ${jsonStringify({
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
      const model = getMainLoopModel()
      const normalizedModel = normalizeModelStringForAPI(model)
      return countMessagesTokensLocally(messages, tools, normalizedModel)
    } catch (error) {
      logForDebugging(`[OpenAI] countTokens error: ${error}`)
      return null
    }
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}
