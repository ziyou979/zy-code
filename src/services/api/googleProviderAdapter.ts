/**
 * Google Provider Adapter — 唯一与 @google/generative-ai SDK 客户端交互的入口。
 *
 * 所有标准格式 ↔ Google 格式的转换都委托给 conversions/google.ts。
 * 客户端创建统一走 client.ts 的 getGoogleClient()，与其他 provider 路径共享基础设施。
 */

import {
  GoogleGenerativeAI,
  type GenerateContentRequest,
  type CountTokensRequest,
} from '@google/generative-ai'
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
import { getGoogleClient } from './client.js'
import {
  buildGoogleRequestParams,
  type GoogleGenerateContentResponse,
  googleResponseToStandard,
  googleStreamToStandard,
  messagesToGoogle,
} from './conversions/google.js'

const log = createDebugLog('google')

export class googleProviderAdapter implements LLMAdapter {
  readonly name = 'google'

  /**
   * 可选注入的 client（测试或外部复用场景）。
   * 未注入时通过 getGoogleClient 懒加载。
   */
  private readonly injectedClient: GoogleGenerativeAI | null

  constructor(client?: GoogleGenerativeAI) {
    this.injectedClient = client ?? null
  }

  private async getClient(model?: string): Promise<GoogleGenerativeAI> {
    if (this.injectedClient) {
      return this.injectedClient
    }
    const { client } = await getGoogleClient({ model })
    return client
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient(params.model)
    const modelName = normalizeModelStringForAPI(params.model)
    const model = client.getGenerativeModel({ model: modelName })

    const requestParams = buildGoogleRequestParams(params)

    log(`Streaming request: model=${params.model}, messages=${requestParams.contents.length}`)
    log(
      `Request params summary: ${jsonStringify({
        model: modelName,
        contentsCount: requestParams.contents.length,
        hasSystemInstruction: !!requestParams.systemInstruction,
        hasTools: !!(requestParams.tools && requestParams.tools.length > 0),
        thinkingConfig: requestParams.generationConfig?.thinkingConfig,
      })}`,
    )

    // SDK 类型严格区分联合类型，适配层需要类型断言
    const result = await model.generateContentStream(
      requestParams as unknown as GenerateContentRequest,
    )

    // Google SDK 的 stream 是 AsyncIterable<GenerateContentResponse>
    const googleStream = result.stream as unknown as AsyncIterable<GoogleGenerateContentResponse>

    return {
      stream: googleStreamToStandard(googleStream, params.model),
      requestId: undefined, // Google SDK 不直接返回 requestId
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient(params.model)
    const modelName = normalizeModelStringForAPI(params.model)
    const model = client.getGenerativeModel({ model: modelName })

    const requestParams = buildGoogleRequestParams(params)

    log(`Non-streaming request: model=${params.model}, messages=${requestParams.contents.length}`)
    log(
      `Request params summary: ${jsonStringify({
        model: modelName,
        contentsCount: requestParams.contents.length,
        hasSystemInstruction: !!requestParams.systemInstruction,
        hasTools: !!(requestParams.tools && requestParams.tools.length > 0),
        thinkingConfig: requestParams.generationConfig?.thinkingConfig,
      })}`,
    )

    // SDK 类型严格区分联合类型，适配层需要类型断言
    const result = await model.generateContent(requestParams as unknown as GenerateContentRequest)

    const response = result.response as unknown as GoogleGenerateContentResponse
    return googleResponseToStandard(response, params.model)
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = getMainLoopModel() ?? ''
      const client = await this.getClient(model)
      const generativeModel = client.getGenerativeModel({
        model: normalizeModelStringForAPI(model),
      })

      const { contents } = messagesToGoogle(messages)

      // Google SDK 的 countTokens 接受 { contents } 或 { generateContentRequest } 参数
      // SDK countTokens 参数类型与自定义 Content 不兼容
      const result = await generativeModel.countTokens({
        contents,
      } as unknown as CountTokensRequest)

      return result.totalTokens ?? null
    } catch (error) {
      log(`countTokens error: ${error}`)
      return null
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const client = new GoogleGenerativeAI(apiKey)
      const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' })

      await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      })

      return true
    } catch (error) {
      if (error instanceof Error && /API_KEY_INVALID|api key|authentication/i.test(error.message)) {
        return false
      }
      throw error
    }
  }
}
