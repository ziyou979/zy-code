/**
 * OpenAI Provider Adapter — 唯一与 openai SDK 客户端交互的入口。
 *
 * 所有标准格式 ↔ OpenAI 格式的转换都委托给 conversions/openai.ts，
 * 本文件只负责创建 client、发起请求、把结果交回。
 */
import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type {
  CreateParams,
  LLMAdapter,
  Response as LLMResponse,
  StreamResult,
} from '../../types/llm.js'
import { getApiKey } from '../../utils/auth.js'
import { getUserAgent } from '../../utils/http.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getProviderEntry } from '../../utils/model/providerRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  buildOpenAIRequestParams,
  mapOpenAIStreamToStandard,
  openAIResponseToStandard,
} from './conversions/openai.js'

// ============================================================================
// 客户端创建
// ============================================================================

function getOpenAIClient(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
}): OpenAI {
  const apiKey = options?.apiKey || getApiKey() || ''

  let baseURL: string | undefined = options?.baseURL
  if (!baseURL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getGlobalConfig } = require('../../utils/config.js')
      baseURL = getGlobalConfig().configuredBaseUrl
    } catch {
      // config not ready
    }
  }
  if (!baseURL) {
    const entry = getProviderEntry(getAPIProvider())
    baseURL = entry?.defaultBaseUrls?.openai
  }
  if (!baseURL) {
    baseURL = 'https://api.openai.com/v1'
  }

  return new OpenAI({
    apiKey,
    baseURL,
    timeout:
      options?.timeout ?? parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    maxRetries: 3,
    defaultHeaders: { 'User-Agent': getUserAgent() },
  })
}

// ============================================================================
// Provider 实现
// ============================================================================

export class OpenAIProviderAdapter implements LLMAdapter {
  readonly name = 'openai'

  private client: OpenAI

  constructor(options?: {
    apiKey?: string
    baseURL?: string
    timeout?: number
  }) {
    this.client = getOpenAIClient(options)
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const requestParams = buildOpenAIRequestParams(params)
    logForDebugging(
      `[OpenAI] Streaming request: model=${(params as any).model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )

    const stream = (await this.client.chat.completions.create(
      {
        ...(requestParams as any),
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
    const requestParams = buildOpenAIRequestParams(params)
    logForDebugging(
      `[OpenAI] Non-streaming request: model=${(params as any).model}, messages=${
        (requestParams.messages as unknown[] | undefined)?.length ?? 0
      }`,
    )

    const completion = await this.client.chat.completions.create(
      {
        ...(requestParams as any),
        stream: false,
      },
      { signal },
    )

    return openAIResponseToStandard(completion, params.model)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}

