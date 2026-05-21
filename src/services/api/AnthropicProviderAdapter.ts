/**
 * Anthropic Provider Adapter — 唯一与 @anthropic-ai/sdk 客户端交互的入口。
 *
 * 所有标准格式 ↔ Anthropic 格式的转换都委托给 conversions/anthropic.ts。
 * 本文件只负责拿到 Anthropic client、发起请求。
 */
import type Anthropic from '@anthropic-ai/sdk'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { getModelBetas } from '../../utils/betas.js'
import { logError } from '../../utils/log.js'
import { getMainLoopModel, normalizeModelStringForAPI } from '../../utils/model/model.js'
import { getAnthropicClient } from './client.js'
import {
  anthropicResponseToStandard,
  anthropicStreamToStandard,
  buildAnthropicCreateParams,
  messagesToAnthropic,
  toolsToAnthropic,
} from './conversions/anthropic.js'

export class AnthropicProviderAdapter implements LLMAdapter {
  readonly name = 'anthropic'

  /**
   * 可选注入的 client（由 withRetry 等基础设施提供，便于复用 retry/auth 逻辑）。
   * 未注入时通过 getAnthropicClient 自取。
   */
  private readonly injectedClient: Anthropic | null

  constructor(client?: Anthropic) {
    this.injectedClient = client ?? null
  }

  private async getClient(model?: string): Promise<Anthropic> {
    if (this.injectedClient) {
      return this.injectedClient
    }
    return getAnthropicClient({ maxRetries: 0, model, source: 'standard_provider' })
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient(params.model)
    const anthropicParams = buildAnthropicCreateParams(params)

    const headers: Record<string, string> = {}
    if (clientRequestId) {
      headers['anthropic-client-request-id'] = clientRequestId
    }

    const result = await client.beta.messages
      .create(
        { ...anthropicParams, stream: true },
        {
          signal,
          ...(Object.keys(headers).length > 0 && { headers }),
        },
      )
      .withResponse()

    const rawStream = result.data as unknown as AsyncIterable<any>

    return {
      stream: anthropicStreamToStandard(rawStream),
      requestId: result.request_id,
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient(params.model)
    const anthropicParams = buildAnthropicCreateParams(params)

    const result = await client.beta.messages.create(
      {
        ...anthropicParams,
        stream: false as const,
        model: normalizeModelStringForAPI(params.model),
      },
      { signal, timeout },
    )
    return anthropicResponseToStandard(result, params.model)
  }

  /**
   * 检查消息是否包含思考块
   */
  private hasThinkingBlocks(messages: LLMMessage[]): boolean {
    for (const message of messages) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            (block.type === 'thinking' || block.type === 'redacted_thinking')
          ) {
            return true
          }
        }
      }
    }
    return false
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = this.hasThinkingBlocks(messages)

      const client = await this.getClient(model)

      // 转换为 Anthropic SDK 接受的格式
      const anthropicMessages = messagesToAnthropic(messages)
      const anthropicTools = toolsToAnthropic(tools)

      const response = await client.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          anthropicMessages.length > 0 ? anthropicMessages : [{ role: 'user', content: 'foo' }],
        ...(anthropicTools &&
          anthropicTools.length > 0 && {
            tools: anthropicTools as any,
          }),
        ...(betas.length > 0 && { betas }),
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: 1024,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  }

  async createRawRequest(params: CreateParams): Promise<Response | null> {
    try {
      const client = await this.getClient(params.model)
      const anthropicParams = buildAnthropicCreateParams(params)
      // .asResponse() 必须在 APIPromise 上调用（链式），不能在 await 后的结果上调用
      const apiPromise = client.beta.messages.create({
        ...anthropicParams,
        stream: false as const,
        model: normalizeModelStringForAPI(params.model),
      })
      return await (apiPromise as any).asResponse()
    } catch (error) {
      logError(error)
      return null
    }
  }

  async listModels(): Promise<Record<string, unknown>[] | null> {
    try {
      const client = await this.getClient()
      const results: Record<string, unknown>[] = []
      for await (const entry of client.models.list({})) {
        results.push(entry as unknown as Record<string, unknown>)
      }
      return results
    } catch (error) {
      logError(error)
      return null
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const client = await getAnthropicClient({
        apiKey,
        maxRetries: 3,
        model,
        source: 'verify_api_key',
      })
      await client.beta.messages.create({
        model: normalizeModelStringForAPI(model),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
        temperature: 1,
        ...(betas.length > 0 && { betas }),
      })
      return true
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication_error')) {
        return false
      }
      throw error
    }
  }
}
