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
  Response as LLMResponse,
  StreamResult,
} from '../../types/llm.js'
import { getAnthropicClient } from './client.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  anthropicResponseToStandard,
  anthropicStreamToStandard,
  buildAnthropicCreateParams,
} from './conversions/anthropic.js'

export class AnthropicProviderAdapter implements LLMAdapter {
  readonly name = 'anthropic'

  /**
   * 可选注入的 client（由 withRetry 等基础设施提供，便于复用 retry/auth 逻辑）。
   * 未注入时通过 getAnthropicClient 自取。
   */
  private injectedClient: Anthropic | null

  constructor(client?: Anthropic) {
    this.injectedClient = client ?? null
  }

  private async getClient(model?: string): Promise<Anthropic> {
    if (this.injectedClient) return this.injectedClient
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
    if (clientRequestId) headers['anthropic-client-request-id'] = clientRequestId

    // @ts-ignore - SDK 内部类型，参数已是 Anthropic 期望的对象
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

    // @ts-ignore - SDK 内部类型
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

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}
