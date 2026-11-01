/**
 * 平台模型列表动态查询服务。
 *
 * 负责根据 provider、baseUrl、apiKey 和 apiFormat 查询可用的模型列表，
 * 每次查询实时获取目录；失败原因交给界面展示，并保留自定义输入。
 *
 * 设计要点：
 * 1. 请求带超时控制，错误与合法空目录分开返回，不阻断设置流程。
 * 2. 多协议端点推导：覆盖 OpenAI 兼容格式（/models）、Ollama 原生标签（/api/tags）、
 *    Anthropic（/v1/models）和 Google Gemini。
 * 3. 不保存进程级目录缓存，进入选择器和手动刷新都可发现新增或下线模型。
 */

import { getAuthConfigForProvider } from '../auth/authConfig.js'
import { getGoogleAdcAuth, isGoogleAdcConnection } from '../auth/googleAdc.js'
import { logForDebugging } from '../infra/debug.js'
import { buildProxiedFetch } from '../http/proxy.js'
import { getGitHubCopilotBaseUrl } from '../oauth/providers/githubCopilot.js'
import { getProviderEntry, type ProviderEntry } from './providerRegistry.js'
import {
  extractModelCatalogCapability,
  type ModelCatalogCapability,
} from './modelCatalogCapabilities.js'

export interface FetchProviderModelsOptions {
  provider: string
  connectionId?: string
  baseUrl?: string
  apiKey?: string
  apiFormat?: 'openai-chat' | 'openai-responses' | 'anthropic' | 'google'
  modelsUrl?: string
  location?: string
  getHeaders?: (url: string) => Promise<HeadersInit>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface DiscoveredModel {
  id: string
  label?: string
  description?: string
  capability?: ModelCatalogCapability
}

export type ModelDiscoveryFailure =
  | 'unsupported'
  | 'authentication'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'cancelled'

export type ModelDiscoveryResult =
  | { status: 'success'; models: DiscoveredModel[] }
  | { status: 'unavailable'; reason: ModelDiscoveryFailure; httpStatus?: number }

/**
 * 根据 Vertex 连接的 baseUrl 与区域推导 Google Publisher 模型列表查询地址。
 *
 * Vertex 的模型目录位于 `/v1beta1/publishers/google/models`（v1 与项目级路径均返回 404）；
 * 多区域（global/us/eu）统一走 `aiplatform.googleapis.com`，单区域走 `{location}-aiplatform.googleapis.com`。
 */
export function resolveVertexModelsUrl(baseUrl?: string, location?: string): string | null {
  const rawBase = baseUrl?.trim() || 'https://aiplatform.googleapis.com/v1beta1'
  let url: URL
  try {
    url = new URL(rawBase)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return null
  }
  const pathLocation = url.pathname.match(/\/locations\/([a-z0-9-]+)(?:\/|$)/)?.[1]
  const hostLocation = url.hostname.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/)?.[1]
  const resolvedLocation = location?.trim() || pathLocation || hostLocation || 'global'
  if (!/^[a-z0-9-]+$/.test(resolvedLocation)) {
    return null
  }
  const host = ['global', 'us', 'eu'].includes(resolvedLocation)
    ? 'aiplatform.googleapis.com'
    : `${resolvedLocation}-aiplatform.googleapis.com`
  return `https://${host}/v1beta1/publishers/google/models?pageSize=100`
}

/**
 * 判断传入的 baseUrl 是否为空或等于该 provider 在注册表中的某个内置默认端点。
 *
 * 多协议平台（如 kimi、mimo、minimax、zhipu、dashscope、openrouter、siliconflow 等）
 * 首位默认格式常为 anthropic（如 https://api.xiaomimimo.com/anthropic），但平台模型目录
 * 统一挂载在 OpenAI 兼容端点（/v1/models）上；当连接使用的是官方内置端点而非自建反代时，
 * 统一按平台官方模型目录端点推导，避免拼出 404 的 /anthropic/v1/models。
 */
function isBuiltInProviderBaseUrl(entry: ProviderEntry | undefined, baseUrl?: string): boolean {
  if (!baseUrl) return true
  if (!entry) return false
  const clean = baseUrl.trim().replace(/\/+$/, '')
  return entry.formatEndpoints.some(
    (ep) => ep.baseUrl && ep.baseUrl.trim().replace(/\/+$/, '') === clean,
  )
}

/**
 * 根据 provider 与 baseUrl 推导默认的模型列表查询 URL
 */
export function resolveDefaultModelsUrl(
  provider: string,
  baseUrl?: string,
  apiFormat?: string,
  location?: string,
): string | null {
  if (provider === 'vertex') {
    if (
      apiFormat === 'google' ||
      (!apiFormat && baseUrl && /\/v1beta1(?:\/|$)|\/publishers\/google(?:\/|$)/.test(baseUrl))
    ) {
      return resolveVertexModelsUrl(baseUrl, location)
    }
    return null
  }
  if (['bedrock', 'gemini-oauth', 'openai-codex'].includes(provider)) {
    return null
  }
  if (provider === 'github-copilot') {
    const clean = baseUrl?.trim().replace(/\/+$/, '') || 'https://api.individual.githubcopilot.com'
    return `${clean}/models`
  }

  const entry = getProviderEntry(provider)
  if (isBuiltInProviderBaseUrl(entry, baseUrl)) {
    // 官方平台的内置默认地址推导
    if (provider === 'openai') return 'https://api.openai.com/v1/models'
    if (provider === 'deepseek') return 'https://api.deepseek.com/models'
    if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/models'
    if (provider === 'siliconflow') return 'https://api.siliconflow.cn/v1/models'
    if (provider === 'stepfun') return 'https://api.stepfun.com/v1/models'
    if (provider === 'kimi') return 'https://api.moonshot.cn/v1/models'
    if (provider === 'zhipu') return 'https://open.bigmodel.cn/api/paas/v4/models'
    if (provider === 'groq') return 'https://api.groq.com/openai/v1/models'
    if (provider === 'together') return 'https://api.together.xyz/v1/models'
    if (provider === 'fireworks') return 'https://api.fireworks.ai/inference/v1/models'
    if (provider === 'ant-ling') return 'https://api.ant-ling.com/v1/models'
    if (provider === 'ollama' || provider === 'local') return 'http://localhost:11434/api/tags'
    if (provider === 'lmstudio') return 'http://localhost:1234/v1/models'
    if (provider === 'llamacpp') return 'http://localhost:8080/v1/models'
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1/models'
    if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/models'
    // 其余内置平台优先选取 OpenAI 兼容端点拼接 /models，避免 anthropic 兼容路径无 /models 导致 404。
    const endpoint =
      entry?.formatEndpoints.find(({ format, baseUrl: url }) => format === 'openai-chat' && url) ??
      entry?.formatEndpoints.find(
        ({ format, baseUrl: url }) => format === 'openai-responses' && url,
      ) ??
      entry?.formatEndpoints.find(({ format }) => format === apiFormat) ??
      entry?.formatEndpoints[0]
    if (!endpoint?.baseUrl) return null
    return `${endpoint.baseUrl.trim().replace(/\/+$/, '')}/models`
  }

  const cleanBase = baseUrl!.trim().replace(/\/+$/, '')

  // Ollama 优先走原生 tags 接口
  if (provider === 'ollama') {
    return `${cleanBase.replace(/\/v1$/, '')}/api/tags`
  }

  // Anthropic 协议
  if (apiFormat === 'anthropic') {
    return cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`
  }

  // Google 协议
  if (apiFormat === 'google') {
    return `${cleanBase}/models`
  }

  // OpenAI 兼容协议（默认）：
  // 若 baseUrl 已经有 /v1，直接拼 /models；否则大部分自建代理挂在 /models 或 /v1/models。
  if (cleanBase.endsWith('/v1')) {
    return `${cleanBase}/models`
  }

  // 特殊平台已知路径处理
  if (provider === 'deepseek') {
    return `${cleanBase}/models`
  }

  return `${cleanBase}/models`
}

/**
 * 解析 API 返回的 JSON 并归一化为 DiscoveredModel 数组
 */
function parseModelsResponse(
  data: unknown,
  provider: string,
  apiFormat?: string,
): DiscoveredModel[] | null {
  if (!data || typeof data !== 'object') {
    return null
  }

  const record = data as Record<string, unknown>
  const results: DiscoveredModel[] = []

  // 1. Ollama 原生返回格式: { models: [{ name, model, size, ... }] }
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      const name = typeof m.name === 'string' ? m.name : m.model
      if (typeof name !== 'string' || !name.trim()) continue
      // Google 原生目录使用 models/ 前缀，并显式声明生成方法。
      const isGoogle = provider === 'gemini' || apiFormat === 'google'
      if (
        isGoogle &&
        Array.isArray(m.supportedGenerationMethods) &&
        !m.supportedGenerationMethods.includes('generateContent')
      )
        continue
      const id = isGoogle ? name.trim().replace(/^models\//, '') : name.trim()
      const sizeBytes = typeof m.size === 'number' ? m.size : undefined
      const sizeDesc = sizeBytes ? `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : undefined
      const capability = extractModelCatalogCapability(m)
      results.push({
        id,
        label: typeof m.displayName === 'string' ? m.displayName : id,
        description: typeof m.description === 'string' ? m.description : sizeDesc,
        ...(capability ? { capability } : {}),
      })
    }
    return results
  }

  // 1.5 Vertex Model Garden Publisher 目录格式: { publisherModels: [{ name, versionId, launchStage, ... }] }
  if (Array.isArray(record.publisherModels)) {
    for (const item of record.publisherModels) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      const rawName = typeof m.name === 'string' ? m.name.trim() : ''
      if (!rawName) continue
      const id = rawName.replace(/^(?:publishers\/google\/)?models\//, '')
      if (!id) continue
      // 仅保留 Gemini 文本/多模态对话模型，过滤嵌入、语音合成/转写、实时音频与纯图像生成模型
      if (
        !/^gemini-/i.test(id) ||
        /(?:embedding|-tts|-transcribe|-live|-image|nano-banana)/i.test(id)
      ) {
        continue
      }
      const capability = extractModelCatalogCapability(m)
      results.push({
        id,
        label: typeof m.displayName === 'string' ? m.displayName : id,
        description: typeof m.description === 'string' ? m.description : undefined,
        ...(capability ? { capability } : {}),
      })
    }
    return results
  }

  // 2. OpenAI / Anthropic 标准格式: { data: [{ id, name, display_name, ... }] }
  if (Array.isArray(record.data)) {
    const isOfficialOpenAI = provider === 'openai'
    for (const item of record.data) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      const id = typeof m.id === 'string' ? m.id.trim() : ''
      if (!id) continue

      // OpenRouter 会返回图像和音频专用模型，仅保留能够输出文本的条目。
      if (m.architecture && typeof m.architecture === 'object') {
        const architecture = m.architecture as Record<string, unknown>
        if (
          Array.isArray(architecture.output_modalities) &&
          !architecture.output_modalities.includes('text')
        )
          continue
      }

      // 针对 OpenAI 官方的纯嵌入/TTS/音频模型做过滤，避免干扰用户选对话模型
      if (isOfficialOpenAI) {
        const nonChatPrefixes = [
          'text-embedding',
          'tts-',
          'whisper-',
          'dall-e-',
          'davinci',
          'babbage',
        ]
        if (nonChatPrefixes.some((prefix) => id.startsWith(prefix))) {
          continue
        }
      }

      // 过滤小米 MiMo 的纯语音识别/语音合成模型（-asr / -tts）
      if (provider === 'mimo' && /-(?:asr|tts)(?:$|-)/i.test(id)) {
        continue
      }

      // GitHub Copilot 仅保留在选择器启用且策略未禁用的模型
      if (provider === 'github-copilot') {
        const policy =
          m.policy && typeof m.policy === 'object' ? (m.policy as Record<string, unknown>) : null
        if (m.model_picker_enabled === false || policy?.state === 'disabled') {
          continue
        }
      }

      const label =
        typeof m.name === 'string'
          ? m.name
          : typeof m.display_name === 'string'
            ? m.display_name
            : id
      const description = typeof m.description === 'string' ? m.description : undefined
      const capability = extractModelCatalogCapability(m)
      results.push({ id, label, description, ...(capability ? { capability } : {}) })
    }
    return results
  }

  // 3. 顶层数组兼容（部分轻量代理直接返回字符串数组或对象数组）
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') {
        const id = item.trim()
        if (id) results.push({ id, label: id })
      } else if (item && typeof item === 'object') {
        const m = item as Record<string, unknown>
        const id =
          typeof m.id === 'string' ? m.id.trim() : typeof m.name === 'string' ? m.name.trim() : ''
        if (id) {
          results.push({ id, label: typeof m.name === 'string' ? m.name : id })
        }
      }
    }
    return results
  }

  return null
}

/**
 * 查询 Provider 可用模型列表。
 *
 * @param options 查询选项（provider, baseUrl, apiKey, apiFormat, modelsUrl 等）
 * @returns 返回实时模型列表或明确的失败原因；不向界面泄露请求头和响应正文。
 */
export async function fetchProviderModels(
  options: FetchProviderModelsOptions,
): Promise<ModelDiscoveryResult> {
  const authConfig = getAuthConfigForProvider(options.connectionId ?? options.provider)
  const effectiveBaseUrl =
    options.baseUrl ??
    (options.provider === 'github-copilot'
      ? getGitHubCopilotBaseUrl(
          options.apiKey,
          typeof authConfig?.oauth?.enterpriseUrl === 'string'
            ? authConfig.oauth.enterpriseUrl
            : undefined,
        )
      : undefined)
  const defaultUrl = resolveDefaultModelsUrl(
    options.provider,
    effectiveBaseUrl,
    options.apiFormat,
    options.location,
  )
  const targetUrl = options.modelsUrl?.trim() || defaultUrl

  if (!targetUrl) {
    return { status: 'unavailable', reason: 'unsupported' }
  }

  const timeoutMs = options.timeoutMs ?? 10000
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': options.provider === 'github-copilot' ? 'GitHubCopilotChat/0.35.0' : 'ZY-Code',
    }
    if (options.provider === 'github-copilot') {
      headers['Editor-Version'] = 'vscode/1.107.0'
      headers['Editor-Plugin-Version'] = 'copilot-chat/0.35.0'
      headers['Copilot-Integration-Id'] = 'vscode-chat'
      headers['X-GitHub-Api-Version'] = '2026-06-01'
    }

    // 根据协议装配认证 Header
    const apiFormat =
      options.apiFormat ?? getProviderEntry(options.provider)?.formatEndpoints[0]?.format
    if (options.getHeaders) {
      const customHeaders = new Headers(await options.getHeaders(targetUrl))
      customHeaders.forEach((value, key) => {
        headers[key] = value
      })
    } else if (options.apiKey?.trim()) {
      const key = options.apiKey.trim()
      if (apiFormat === 'anthropic') {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
        // 第三方双协议平台的模型目录常挂在 OpenAI 兼容网关，同时携带 Bearer 以兼容两类鉴权
        if (options.provider !== 'anthropic') {
          headers['Authorization'] = `Bearer ${key}`
        }
      } else if (apiFormat === 'google') {
        headers['x-goog-api-key'] = key
      } else {
        headers['Authorization'] = `Bearer ${key}`
      }
    } else if (
      options.provider === 'vertex' ||
      isGoogleAdcConnection(options.connectionId ?? options.provider)
    ) {
      // 安全边界：ADC 凭证仅允许发送至官方 aiplatform.googleapis.com 端点
      if (!resolveVertexModelsUrl(targetUrl)) {
        return { status: 'unavailable', reason: 'unsupported' }
      }
      try {
        const adcHeaders = new Headers(
          await getGoogleAdcAuth(authConfig?.vertex?.credentialsFile).getRequestHeaders(targetUrl),
        )
        const authHeader = adcHeaders.get('Authorization')
        if (!authHeader) {
          return { status: 'unavailable', reason: 'authentication' }
        }
        headers['Authorization'] = authHeader
        if (authConfig?.vertex?.project) {
          headers['x-goog-user-project'] = authConfig.vertex.project
        }
      } catch {
        return { status: 'unavailable', reason: 'authentication' }
      }
    }

    const request = buildProxiedFetch() ?? globalThis.fetch
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
    let response = await request(targetUrl, {
      method: 'GET',
      headers,
      signal,
    })
    // 若连接残留了旧版自动生成的错误 modelsUrl（如 /anthropic/v1/models 404），回退尝试平台标准目录地址
    if (
      response.status === 404 &&
      options.modelsUrl?.trim() &&
      defaultUrl &&
      defaultUrl !== targetUrl &&
      getProviderEntry(options.provider)
    ) {
      response = await request(defaultUrl, {
        method: 'GET',
        headers,
        signal,
      })
    }

    if (!response.ok) {
      logForDebugging(
        `[fetchProviderModels] HTTP ${response.status} (provider: ${options.provider})`,
      )
      return {
        status: 'unavailable',
        reason: response.status === 401 || response.status === 403 ? 'authentication' : 'http',
        httpStatus: response.status,
      }
    }

    let json: unknown
    try {
      json = await response.json()
    } catch {
      return { status: 'unavailable', reason: 'invalid-response' }
    }
    const models = parseModelsResponse(json, options.provider, apiFormat)
    if (models === null) return { status: 'unavailable', reason: 'invalid-response' }

    // 对模型列表去重并按 ID 排序
    const seen = new Set<string>()
    const uniqueModels: DiscoveredModel[] = []
    for (const m of models) {
      if (!seen.has(m.id.toLowerCase())) {
        seen.add(m.id.toLowerCase())
        uniqueModels.push(m)
      }
    }

    return { status: 'success', models: uniqueModels }
  } catch {
    return {
      status: 'unavailable',
      reason: options.signal?.aborted
        ? 'cancelled'
        : controller.signal.aborted
          ? 'timeout'
          : 'network',
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
