import { getGoogleAdcAuth } from '../auth/googleAdc.js'
import { tSync } from '../../i18n/index.js'
import { isConnectionError, LLMConnectionError, LLMError } from '../../types/llm.js'
import type {
  CreateParams,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  StreamResult,
  ToolDefinition,
} from '../../types/llm.js'
import { getAuthConfigForProvider, type AuthProviderConfig } from '../auth/authConfig.js'
import { buildProxiedFetch } from '../http/proxy.js'
import { getMainLoopModel, normalizeModelStringForAPI } from '../model/model.js'
import { resolveModelRequestContext } from '../model/modelRequestContext.js'
import { resolveApiBaseUrl } from './baseUrlResolution.js'
import {
  buildGoogleRequestParams,
  googleResponseToStandard,
  googleStreamToStandard,
  type GoogleCandidate,
  type GoogleGenerateContentRequest,
  type GooglePart,
  type GoogleGenerateContentResponse,
} from './conversions/google.js'
import { GoogleContinuationState } from './googleContinuation.js'
import { parseGoogleSseStream } from './googleSseStream.js'
import { normalizeFetchError } from './errorUtils.js'
import { createDebugLog } from '../infra/debug.js'

const log = createDebugLog('api:vertex')

type VertexTarget = { baseUrl: string; project: string; location: string }
type VertexRequestContext = VertexTarget & { headers: Headers }

/** 完整 publisher URL 可用于命名连接；区域地址不沿用 Anthropic 的默认 URL。 */
export function resolveVertexTarget(
  config: Pick<AuthProviderConfig, 'vertex'>,
  baseUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): VertexTarget {
  const project = config.vertex?.project ?? env.GOOGLE_CLOUD_PROJECT
  const location = config.vertex?.location ?? env.GOOGLE_CLOUD_LOCATION ?? 'global'
  const url = new URL(
    baseUrl ??
      `https://${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com/v1beta1`,
  )
  // ADC 不发送到任意自定义服务器；避免基础设施凭据随错误端点泄漏。
  if (
    url.protocol !== 'https:' ||
    !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new LLMError(tSync('vertex.invalidEndpoint'))
  }
  const fullPath = url.pathname
    .replace(/\/+$/, '')
    .match(/^\/(v1(?:beta1)?)\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google$/)
  if (fullPath) {
    return {
      baseUrl: url.toString().replace(/\/+$/, ''),
      project: fullPath[2]!,
      location: fullPath[3]!,
    }
  }
  if (
    !project ||
    !/^[a-zA-Z0-9-]+$/.test(project) ||
    !/^[a-z0-9-]+$/.test(location) ||
    !/^\/v1(?:beta1)?\/?$/.test(url.pathname)
  ) {
    throw new LLMError(tSync('vertex.projectMissing'))
  }
  // 内置 Google 默认端点按连接区域调整；显式完整端点则保留其路由。
  if (url.hostname === 'aiplatform.googleapis.com' && location !== 'global') {
    url.hostname = `${location}-aiplatform.googleapis.com`
  }
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}/projects/${project}/locations/${location}/publishers/google`,
    project,
    location,
  }
}

async function resolveVertexContext(model: string): Promise<VertexRequestContext> {
  const context = resolveModelRequestContext(model)
  const config = getAuthConfigForProvider(context.authProfile ?? context.provider) ?? {}
  const target = resolveVertexTarget(config, resolveApiBaseUrl({ context }))
  const headers = new Headers(
    await getGoogleAdcAuth(config.vertex?.credentialsFile).getRequestHeaders(target.baseUrl),
  )
  headers.set('Content-Type', 'application/json')
  // 连接选择的配额项目优先于 ADC 文件或其他终端环境中的旧值，不改写共享凭证。
  headers.set('x-goog-user-project', target.project)
  return { ...target, headers }
}

export class VertexGoogleProviderAdapter implements LLMAdapter {
  readonly name = 'vertex-google'

  constructor(
    private readonly options: {
      resolveContext?: (model: string) => Promise<VertexRequestContext>
      fetch?: (input: string, init: RequestInit) => Promise<Response>
    } = {},
  ) {}

  private async request(
    model: string,
    action: string,
    body: GoogleGenerateContentRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted()
    const context = await (this.options.resolveContext ?? resolveVertexContext)(model)
    signal?.throwIfAborted()
    const modelId = normalizeModelStringForAPI(model).replace(/^(?:google\/|models\/)/, '')
    if (!/^[a-zA-Z0-9._-]+$/.test(modelId)) {
      throw new LLMError(tSync('vertex.invalidModel'))
    }
    if (/^gemini-4-/.test(modelId) && !['global', 'us', 'eu'].includes(context.location)) {
      throw new LLMError(tSync('vertex.invalidGemini4Location'))
    }
    if (
      /^gemini-4-/.test(modelId) &&
      /\/v1\//.test(context.baseUrl) &&
      (body.continuationToken ||
        (action !== 'countTokens' &&
          (body.generationConfig?.maxOutputTokens ?? 0) >
            (action === 'generateContent' ? 32768 : 65536)))
    ) {
      throw new LLMError(tSync('vertex.continuationRequiresBeta'), 400)
    }
    const doFetch = this.options.fetch ?? buildProxiedFetch() ?? fetch
    let response: Response
    try {
      response = await doFetch(`${context.baseUrl}/models/${modelId}:${action}`, {
        method: 'POST',
        headers: context.headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw normalizeFetchError(error, signal)
    }
    if (!response.ok) {
      const text = await response.text().catch((error: unknown) => {
        throw normalizeFetchError(error, signal)
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      throw new LLMError(text || response.statusText, response.status, headers)
    }
    return response
  }

  private async *readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    model: string,
  ): AsyncGenerator<GoogleGenerateContentResponse> {
    let completed = false
    const startedAt = Date.now()
    let chunks = 0
    let textChars = 0
    let thinkingChars = 0
    let functionCallParts = 0
    let finishReason: string | undefined
    let usage: GoogleGenerateContentResponse['usageMetadata']
    let idleWarning: ReturnType<typeof setTimeout> | undefined
    const phases = new Set<string>()
    const summary = () =>
      JSON.stringify({
        model,
        elapsedMs: Date.now() - startedAt,
        chunks,
        textChars,
        thinkingChars,
        functionCallParts,
        completed,
        finishReason,
        usage: usage && {
          promptTokenCount: usage.promptTokenCount,
          candidatesTokenCount: usage.candidatesTokenCount,
          thoughtsTokenCount: usage.thoughtsTokenCount,
          cachedContentTokenCount: usage.cachedContentTokenCount,
          totalTokenCount: usage.totalTokenCount,
        },
      })
    const resetIdleWarning = () => {
      if (idleWarning) {
        idleWarning.refresh()
      } else {
        idleWarning = setTimeout(() => {
          idleWarning = undefined
          log(`stream idle: no SSE packets for 30s ${summary()}`, { level: 'warn' })
        }, 30000)
        idleWarning.unref()
      }
    }
    try {
      resetIdleWarning()
      for await (const chunk of parseGoogleSseStream(body)) {
        chunks++
        const candidate = chunk.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          // 只记录结构和计数，不记录正文、工具参数、签名或认证头。
          const phase = part.functionCall
            ? 'tool'
            : part.thought
              ? 'thinking'
              : part.text
                ? 'text'
                : 'metadata'
          if (!phases.has(phase)) {
            phases.add(phase)
            log(`stream phase=${phase} model=${model} elapsedMs=${Date.now() - startedAt}`)
          }
          if (part.thought) {
            thinkingChars += part.text?.length ?? 0
          } else {
            textChars += part.text?.length ?? 0
          }
          if (part.functionCall) {
            functionCallParts++
          }
        }
        finishReason = candidate?.finishReason ?? chunk.promptFeedback?.blockReason ?? finishReason
        if (chunk.usageMetadata) {
          usage = { ...usage, ...chunk.usageMetadata }
        }
        completed ||= Boolean(
          chunk.candidates?.[0]?.finishReason || chunk.promptFeedback?.blockReason,
        )
        if (completed) {
          clearTimeout(idleWarning)
          idleWarning = undefined
        } else {
          resetIdleWarning()
        }
        yield chunk
      }
    } catch (error) {
      const normalized = normalizeFetchError(error, signal)
      // 完成标记后仍读取尾部用量；仅忽略随后发生的断线，API 错误和用户取消仍传播。
      if (completed && !signal.aborted && isConnectionError(normalized)) {
        return
      }
      throw normalized
    } finally {
      clearTimeout(idleWarning)
      log(`stream summary ${summary()}`, { level: completed ? 'debug' : 'warn' })
    }
    if (!completed) {
      throw new LLMConnectionError(tSync('vertex.incompleteStream'), 'ECONNRESET')
    }
  }

  private async *readContinuationStream(
    initialResponse: Response,
    request: GoogleGenerateContentRequest,
    model: string,
    signal: AbortSignal,
  ): AsyncGenerator<GoogleGenerateContentResponse> {
    const state = new GoogleContinuationState(request.generationConfig?.maxOutputTokens ?? 65536)
    let response = initialResponse
    while (true) {
      if (!response.body) {
        throw new LLMError(tSync('vertex.emptyResponse'))
      }
      let candidate: GoogleCandidate | undefined
      for await (const chunk of this.readStream(response.body, signal, model)) {
        const current = chunk.candidates?.[0]
        if (current?.finishReason) {
          candidate = current
        }
        const normalized = state.update(chunk)
        if (current?.finishReason === 'CONTINUATION') {
          // 检查点仍属于同一轮，不关闭标准消息或释放尚未完成的工具。
          yield {
            ...normalized,
            candidates: [{ ...current, finishReason: undefined, continuationToken: undefined }],
          }
        } else {
          yield normalized
        }
      }
      const continuationToken = state.finish(candidate)
      if (!continuationToken) {
        return
      }
      signal.throwIfAborted()
      log(`stream continuation model=${model}`)
      // 原始 prompt、工具、思考强度与总预算保持一致，不追加部分输出。
      response = await this.request(
        model,
        'streamGenerateContent?alt=sse',
        { ...request, continuationToken },
        signal,
      )
    }
  }

  async createStream(params: CreateParams, signal: AbortSignal): Promise<StreamResult> {
    // 上层空闲看门狗通过 controller 释放流；锁定的 Response.body.cancel() 无法中止读取。
    const controller = new AbortController()
    const requestSignal = AbortSignal.any([signal, controller.signal])
    const request = buildGoogleRequestParams(params, 'json-schema')
    const startedAt = Date.now()
    log(
      `stream request ${JSON.stringify({ model: params.model, turns: request.contents.length, tailRole: request.contents.at(-1)?.role, tools: request.tools?.[0]?.functionDeclarations?.length ?? 0, systemChars: request.systemInstruction?.parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) ?? 0, maxOutputTokens: request.generationConfig?.maxOutputTokens, thinkingLevel: request.generationConfig?.thinkingConfig?.thinkingLevel, includeThoughts: request.generationConfig?.thinkingConfig?.includeThoughts })}`,
    )
    const response = await this.request(
      params.model,
      'streamGenerateContent?alt=sse',
      request,
      requestSignal,
    )
    log(
      `stream headers model=${params.model} status=${response.status} elapsedMs=${Date.now() - startedAt}`,
    )
    if (!response.body) {
      throw new LLMError(tSync('vertex.emptyResponse'))
    }
    return {
      stream: Object.assign(
        googleStreamToStandard(
          this.readContinuationStream(response, request, params.model, requestSignal),
          params.model,
          'delta',
        ),
        { controller },
      ),
      response,
      requestId: response.headers.get('x-request-id') ?? undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMResponse> {
    const request = buildGoogleRequestParams(params, 'json-schema')
    // 每个非流式分段共用一次超时预算，不因续传重新获得完整等待时间。
    const requestSignal = timeout ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal
    log(
      `non-stream request model=${params.model} maxOutputTokens=${request.generationConfig?.maxOutputTokens} timeoutMs=${timeout ?? 'none'}`,
    )
    const state = new GoogleContinuationState(request.generationConfig?.maxOutputTokens ?? 65536)
    const parts: GooglePart[] = []
    let continuationToken: string | undefined
    let responseId: string | undefined
    while (true) {
      const response = await this.request(
        params.model,
        'generateContent',
        { ...request, ...(continuationToken && { continuationToken }) },
        requestSignal,
      )
      const chunk = (await response.json().catch((error: unknown) => {
        throw normalizeFetchError(error, requestSignal)
      })) as GoogleGenerateContentResponse
      responseId ??= chunk.responseId
      const candidate = chunk.candidates?.[0]
      parts.push(...(candidate?.content?.parts ?? []))
      const normalized = state.update(chunk)
      continuationToken = state.finish(candidate)
      if (!continuationToken) {
        return googleResponseToStandard(
          {
            ...normalized,
            responseId,
            ...(candidate && {
              candidates: [{ ...candidate, content: { role: 'model', parts } }],
            }),
          },
          params.model,
        )
      }
      requestSignal.throwIfAborted()
      log(`non-stream continuation model=${params.model}`)
    }
  }

  async countTokens(messages: LLMMessage[], tools: ToolDefinition[]): Promise<number | null> {
    try {
      const model = getMainLoopModel()
      if (!model) {
        return null
      }
      const request = buildGoogleRequestParams(
        { model, messages, tools, maxTokens: 1 },
        'json-schema',
        'count',
      )
      const { generationConfig: _generationConfig, ...tokenRequest } = request
      const response = await this.request(
        model,
        'countTokens',
        tokenRequest,
        AbortSignal.timeout(15000),
      )
      const result = (await response.json()) as { totalTokens?: number }
      return result.totalTokens ?? null
    } catch {
      return null
    }
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    // ADC 验证只计数，不触发付费的文本生成。
    return (
      (await this.countTokens(
        [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        [],
      )) !== null
    )
  }
}
