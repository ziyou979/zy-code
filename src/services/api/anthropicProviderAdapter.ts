/**
 * Anthropic Provider Adapter — 唯一与 @anthropic-ai/sdk 客户端交互的入口。
 *
 * 所有标准格式 ↔ Anthropic 格式的转换都委托给 conversions/anthropic.ts。
 * 本文件只负责拿到 Anthropic client、发起请求。
 */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import {
  getAuthProfileForModel,
  getMainLoopModel,
  getProviderForModel,
  normalizeModelStringForAPI,
} from '../model/model.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { getModelBetas } from '../feature-flags/betas.js'
import { logError } from '../../services/infra/log.js'
import { getApiKey } from '../auth/auth.js'
import { getOAuthProviderIdForConnection } from '../oauth/oauthStorage.js'
import { getProxyFetchOptions } from '../http/proxy.js'
import { getAnthropicClient } from './client.js'
import {
  anthropicResponseToStandard,
  anthropicStreamToStandard,
  buildAnthropicCreateParams,
  messagesToAnthropic,
  toolsToAnthropic,
} from './conversions/anthropic.js'

const ANTHROPIC_OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20'
const ANTHROPIC_OAUTH_BETA_LIST = ANTHROPIC_OAUTH_BETAS.split(',')
const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** 创建 Claude Pro/Max 订阅专用客户端，与普通 API Key 鉴权严格分离。 */
export function getAnthropicOAuthClient(options: {
  accessToken: string
  baseURL?: string
  maxRetries?: number
  timeout?: number
  fetch?: ClientOptions['fetch']
  userAgent?: string
}): Anthropic {
  return new Anthropic({
    apiKey: null,
    authToken: options.accessToken,
    baseURL: options.baseURL,
    maxRetries: options.maxRetries ?? 0,
    timeout: options.timeout ?? 600 * 1000,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      accept: 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': ANTHROPIC_OAUTH_BETAS,
      'user-agent': options.userAgent ?? 'claude-cli/2.1.75',
      'x-app': 'cli',
    },
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
    ...(options.fetch && { fetch: options.fetch }),
  } as ClientOptions & { fetchOptions: ReturnType<typeof getProxyFetchOptions> })
}

/** OAuth inference 要求把 Claude Code 身份作为首个 system block。 */
export function buildAnthropicOAuthRequestParams(
  params: CreateParams,
): ReturnType<typeof buildAnthropicCreateParams> {
  const request = buildAnthropicCreateParams(params)
  const existingSystem = request.system
  const systemBlocks: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: ANTHROPIC_OAUTH_IDENTITY },
  ]
  if (typeof existingSystem === 'string') {
    systemBlocks.push({ type: 'text', text: existingSystem })
  } else if (Array.isArray(existingSystem)) {
    for (const block of existingSystem) {
      if (block.type === 'text') {
        systemBlocks.push({ type: 'text', text: block.text })
      }
    }
  }
  const requestBetas = Array.isArray(request.betas) ? request.betas : []
  return {
    ...request,
    system: systemBlocks,
    betas: [...new Set([...ANTHROPIC_OAUTH_BETA_LIST, ...requestBetas])],
  }
}

export class anthropicProviderAdapter implements LLMAdapter {
  readonly name = 'anthropic'

  /**
   * 可选注入的 client（由 withRetry 等基础设施提供，便于复用 retry/auth 逻辑）。
   * 未注入时通过 getAnthropicClient 自取。
   */
  private readonly injectedClient: Anthropic | null

  constructor(client?: Anthropic) {
    this.injectedClient = client ?? null
  }

  private async getClient(model?: string): Promise<{ client: Anthropic; isOAuth: boolean }> {
    const connectionId = getAuthProfileForModel(model) ?? getProviderForModel(model)
    const storedOAuth = getOAuthProviderIdForConnection(connectionId) === 'anthropic'
    const environmentOAuth =
      getProviderForModel(model) === 'anthropic' ? process.env.ANTHROPIC_AUTH_TOKEN : undefined
    if (storedOAuth || environmentOAuth) {
      const accessToken = storedOAuth ? getApiKey(connectionId) : environmentOAuth
      if (!accessToken) {
        throw new Error('Anthropic OAuth token is unavailable')
      }
      return {
        client: getAnthropicOAuthClient({ accessToken }),
        isOAuth: true,
      }
    }
    // 主请求基础设施会预先创建普通客户端；OAuth 分支必须优先，避免误用注入的 API Key 客户端。
    if (this.injectedClient) {
      return { client: this.injectedClient, isOAuth: false }
    }
    return {
      client: await getAnthropicClient({ maxRetries: 0, model, source: 'standard_provider' }),
      isOAuth: false,
    }
  }

  private buildRequest(params: CreateParams, isOAuth: boolean) {
    return isOAuth ? buildAnthropicOAuthRequestParams(params) : buildAnthropicCreateParams(params)
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    clientRequestId?: string,
  ): Promise<StreamResult> {
    const { client, isOAuth } = await this.getClient(params.model)
    const anthropicParams = this.buildRequest(params, isOAuth)

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

    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 流式类型转换
    const rawStream = result.data as unknown as AsyncIterable<any>

    return {
      stream: anthropicStreamToStandard(rawStream),
      requestId: result.request_id ?? undefined,
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMResponse> {
    const { client, isOAuth } = await this.getClient(params.model)
    const anthropicParams = this.buildRequest(params, isOAuth)

    const result = await client.beta.messages.create(
      {
        ...anthropicParams,
        stream: false as const,
        model: normalizeModelStringForAPI(params.model),
      },
      { signal, ...(timeout !== undefined && { timeout }) },
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
      const model = getMainLoopModel() ?? ''
      const betas = getModelBetas(model)
      const containsThinking = this.hasThinkingBlocks(messages)

      const { client, isOAuth } = await this.getClient(model)

      // 转换为 Anthropic SDK 接受的格式
      const anthropicMessages = messagesToAnthropic(messages)
      const anthropicTools = toolsToAnthropic(tools)

      const response = await client.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          anthropicMessages.length > 0 ? anthropicMessages : [{ role: 'user', content: 'foo' }],
        ...(anthropicTools &&
          anthropicTools.length > 0 && {
            tools: anthropicTools as unknown as Anthropic.MessageCountTokensTool[],
          }),
        ...(betas.length > 0 && { betas }),
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: 1024,
          },
        }),
        ...(isOAuth && {
          system: [{ type: 'text', text: ANTHROPIC_OAUTH_IDENTITY }],
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
      const { client, isOAuth } = await this.getClient(params.model)
      const anthropicParams = this.buildRequest(params, isOAuth)
      // .asResponse() 必须在 APIPromise 上调用（链式），不能在 await 后的结果上调用
      const apiPromise = client.beta.messages.create({
        ...anthropicParams,
        stream: false as const,
        model: normalizeModelStringForAPI(params.model),
      })
      return await (apiPromise as unknown as { asResponse: () => Promise<Response> }).asResponse()
    } catch (error) {
      logError(error)
      return null
    }
  }

  async listModels(): Promise<Record<string, unknown>[] | null> {
    try {
      const { client } = await this.getClient()
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
      const model = getMainLoopModel() ?? ''
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
