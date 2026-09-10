/**
 * Google Code Assist 订阅适配器（gemini-oauth / Google AI Pro/Ultra）。
 *
 * v1internal 端点与公开 Gemini API 的差异集中在此处：
 * - 鉴权走 Bearer OAuth token（而非 x-goog-api-key）
 * - 请求体是 {model, project, request} 信封（内层为标准 generateContent 请求）
 * - 响应/流式格式与标准 Gemini 一致，转换复用 conversions/google.ts
 *
 * 协议细节参考 CLIProxyAPI 的 antigravity executor 实现。
 */

import { getAuthProfileForModel, getMainLoopModel, getProviderForModel } from '../model/model.js'
import {
  isOAuthTokenExpiredForConnection,
  getOAuthCredentialsForConnection,
  refreshOAuthTokenForConnection,
} from '../oauth/oauthStorage.js'
import { getAuthConfigForProvider } from '../auth/authConfig.js'
import {
  antigravityRequestUserAgent,
  type GeminiOAuthCredentials,
} from '../oauth/providers/geminiOauth.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { LLMError } from '../../types/llm.js'
import { tSync } from '../../i18n/index.js'
import { createDebugLog } from '../infra/debug.js'
import { buildProxiedFetch } from '../http/proxy.js'
import {
  buildGoogleRequestParams,
  type GoogleGenerateContentRequest,
  type GoogleGenerateContentResponse,
  googleResponseToStandard,
  googleStreamToStandard,
  messagesToGoogle,
} from './conversions/google.js'

const log = createDebugLog('code-assist')

const DEFAULT_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal'

/**
 * 构建 v1internal 请求信封。
 *
 * Antigravity 客户端从不发送显式 maxOutputTokens（输出预算由服务端管理），
 * 对 gemini-3 系列模型保留该字段会被拒绝，因此主动删除；更早的模型
 * （gemini-2.x）沿用公开 API 行为，予以保留。
 */
export function buildCodeAssistEnvelope(
  model: string,
  project: string,
  request: GoogleGenerateContentRequest,
): { model: string; project: string; request: GoogleGenerateContentRequest } {
  const envelope = { model, project, request }
  if (/^gemini-3/.test(model) && envelope.request.generationConfig) {
    delete envelope.request.generationConfig.maxOutputTokens
  }
  return envelope
}

/** v1internal 请求的统一 header（Bearer 认证 + Antigravity UA 指纹） */
function codeAssistHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    Authorization: `Bearer ${token}`,
    'User-Agent': antigravityRequestUserAgent(),
    'X-Goog-Api-Client': 'gl-node/22.21.1',
  }
}

type CodeAssistContext = {
  token: string
  project: string
  baseUrl: string
}

/**
 * 解析当前模型对应的 OAuth 连接，取出 token 与 cloudaicompanionProject。
 *
 * Google access token 仅 1 小时有效且同步取值路径不刷新，因此请求前主动
 * 检查过期并刷新，避免等到 401 才走恢复路径。
 */
async function resolveCodeAssistContext(model: string): Promise<CodeAssistContext> {
  const connectionId = getAuthProfileForModel(model) ?? getProviderForModel(model)
  if (!connectionId) {
    throw new LLMError(`No OAuth connection found for model: ${model}`)
  }

  if (isOAuthTokenExpiredForConnection(connectionId)) {
    const refreshed = await refreshOAuthTokenForConnection(connectionId)
    if (!refreshed) {
      log(`Token refresh failed for connection: ${connectionId}`)
    }
  }

  const credentials = getOAuthCredentialsForConnection(
    connectionId,
  ) as GeminiOAuthCredentials | null
  if (!credentials?.access) {
    throw new LLMError('Google subscription OAuth token is unavailable')
  }
  if (!credentials.project) {
    throw new LLMError(tSync('oauth.gemini.projectMissing'))
  }

  // auth.json 连接级 baseUrl 覆盖（测试/区域端点），默认走生产端点
  const baseUrl =
    getAuthConfigForProvider(connectionId)?.baseUrl?.trim() || DEFAULT_CODE_ASSIST_BASE_URL
  return { token: credentials.access, project: credentials.project, baseUrl }
}

/**
 * 解析 v1internal 的 SSE 响应为 Gemini chunk 流。
 *
 * streamGenerateContent?alt=sse 的每个事件是单个 `data:` 行携带完整 JSON
 * chunk（Gemini 不使用多行 data 拼接），按行解析即可。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GoogleGenerateContentResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        const chunk = parseSseDataLine(line)
        if (chunk !== undefined) {
          yield chunk
        }
      }
    }

    // 流结束后处理残留缓冲（最后一行可能没有换行结尾）
    const tailLine = buffer.replace(/\r$/, '')
    if (tailLine) {
      const chunk = parseSseDataLine(tailLine)
      if (chunk !== undefined) {
        yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 解析单个 SSE data 行；非 data 行、[DONE] 与非法 JSON 返回 undefined */
function parseSseDataLine(line: string): GoogleGenerateContentResponse | undefined {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return undefined
  try {
    return JSON.parse(payload) as GoogleGenerateContentResponse
  } catch (error) {
    log(`Failed to parse SSE chunk: ${error}`)
    return undefined
  }
}

/** 将上游错误响应转换为带状态码的 LLMError（便于重试层识别） */
async function toUpstreamError(response: Response, url: string): Promise<LLMError> {
  const text = await response.text().catch(() => '')
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  return new LLMError(
    `Code Assist request failed. status=${response.status}; url=${url}; body=${text}`,
    response.status,
    headers,
  )
}

export class CodeAssistProviderAdapter implements LLMAdapter {
  readonly name = 'code-assist'

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const { token, project, baseUrl } = await resolveCodeAssistContext(params.model)
    const url = `${baseUrl}:streamGenerateContent?alt=sse`
    const body = buildCodeAssistEnvelope(params.model, project, buildGoogleRequestParams(params))

    log(`Streaming request: model=${params.model}, project=${project}`)
    const doFetch = buildProxiedFetch() ?? fetch
    const response = await doFetch(url, {
      method: 'POST',
      headers: codeAssistHeaders(token),
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok || !response.body) {
      throw await toUpstreamError(response, url)
    }

    return {
      stream: googleStreamToStandard(parseSseStream(response.body), params.model),
      requestId: response.headers.get('x-request-id') ?? undefined,
      response,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMResponse> {
    const { token, project, baseUrl } = await resolveCodeAssistContext(params.model)
    const url = `${baseUrl}:generateContent`
    const body = buildCodeAssistEnvelope(params.model, project, buildGoogleRequestParams(params))

    log(`Non-streaming request: model=${params.model}, project=${project}`)
    const doFetch = buildProxiedFetch() ?? fetch
    const response = await doFetch(url, {
      method: 'POST',
      headers: codeAssistHeaders(token),
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      throw await toUpstreamError(response, url)
    }

    const data = (await response.json()) as GoogleGenerateContentResponse
    return googleResponseToStandard(data, params.model)
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = getMainLoopModel() ?? ''
      const { token, project, baseUrl } = await resolveCodeAssistContext(model)
      const { contents } = messagesToGoogle(messages)
      const request: GoogleGenerateContentRequest = { contents }
      if (tools.length > 0) {
        // countTokens 同样接受信封内的标准工具声明
        request.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              ...(tool.description && { description: tool.description }),
              ...(tool.inputSchema && { parameters: tool.inputSchema as Record<string, unknown> }),
            })),
          },
        ]
      }
      const url = `${baseUrl}:countTokens`
      const doFetch = buildProxiedFetch() ?? fetch
      const response = await doFetch(url, {
        method: 'POST',
        headers: codeAssistHeaders(token),
        body: JSON.stringify(buildCodeAssistEnvelope(model, project, request)),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        throw await toUpstreamError(response, url)
      }
      const data = (await response.json()) as { totalTokens?: number }
      return data.totalTokens ?? null
    } catch (error) {
      log(`countTokens error: ${error}`)
      return null
    }
  }

  async verifyApiKey(apiKey: string): Promise<boolean> {
    // OAuth 路径的 apiKey 参数即 access token；loadCodeAssist 轻量且不消耗
    // 生成配额，适合做凭证有效性探测
    const { verifyGeminiSubscriptionAccess } = await import('../oauth/providers/geminiOauth.js')
    return verifyGeminiSubscriptionAccess(apiKey)
  }
}
