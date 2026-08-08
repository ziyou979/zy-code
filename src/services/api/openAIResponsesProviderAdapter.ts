/**
 * OpenAI Responses Provider Adapter — 唯一与 openai SDK 的 responses API 交互的入口。
 *
 * 与 OpenAIProviderAdapter（chat.completions）共用 getOpenAIClient() 的客户端
 * 基础设施（headers/baseUrl/proxy/debug），同一 OpenAI 客户端实例同时持有
 * chat.completions 与 responses 两个方法。
 * 所有标准格式 ↔ Responses 格式的转换都委托给 conversions/openaiResponses.ts。
 */

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { getMainLoopModel, normalizeModelStringForAPI } from '../model/model.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { countMessagesTokensLocally } from '../tokenEstimation.js'
import { getOpenAIClient } from './client.js'
import {
  buildResponsesRequestParams,
  mapResponsesStreamToStandard,
  responsesToStandard,
} from './conversions/openaiResponses.js'

const log = createDebugLog('openai-responses')

export class OpenAIResponsesProviderAdapter implements LLMAdapter {
  readonly name = 'openai-responses'

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
    const requestParams = buildResponsesRequestParams(params)
    log(
      `Streaming request: model=${params.model}, input items=${
        Array.isArray(requestParams.input) ? requestParams.input.length : 1
      }`,
    )
    log(
      `Streaming request params summary: ${jsonStringify({
        model: requestParams.model,
        inputCount: Array.isArray(requestParams.input) ? requestParams.input.length : 1,
        toolsCount: (requestParams.tools as unknown[] | undefined)?.length ?? 0,
        stream: true,
      })}`,
    )

    const stream = (await client.responses.create(
      {
        ...requestParams,
        stream: true,
      },
      { signal },
    )) as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>

    return {
      stream: mapResponsesStreamToStandard(stream, params.model),
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
    const requestParams = buildResponsesRequestParams(params)
    log(
      `Non-streaming request: model=${params.model}, input items=${
        Array.isArray(requestParams.input) ? requestParams.input.length : 1
      }`,
    )
    log(
      `Non-streaming request params summary: ${jsonStringify({
        model: requestParams.model,
        inputCount: Array.isArray(requestParams.input) ? requestParams.input.length : 1,
        toolsCount: (requestParams.tools as unknown[] | undefined)?.length ?? 0,
        stream: false,
      })}`,
    )

    const response = await client.responses.create(
      {
        ...requestParams,
        stream: false,
      },
      { signal },
    )

    return responsesToStandard(response, params.model)
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
      // Responses 无 max_tokens，用 max_output_tokens 发最小请求验证
      await client.responses.create({
        model: normalizeModelStringForAPI(model),
        input: 'test',
        max_output_tokens: 1,
      })
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
