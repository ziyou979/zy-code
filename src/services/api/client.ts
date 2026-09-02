import { randomUUID } from 'node:crypto'
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { resolveModelRequestContext } from 'src/services/model/modelRequestContext.js'
import { isCustomEndpointProvider, isEnvEndpointProvider } from 'src/services/model/providers.js'
import { getApiKey, getApiKeyFromApiKeyHelper } from 'src/services/auth/auth.js'
import { getUserAgent } from 'src/services/http/http.js'
import { buildProxiedFetch, getProxyFetchOptions } from 'src/services/http/proxy.js'
import { getOAuthProviderIdForConnection } from 'src/services/oauth/oauthStorage.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { getOauthConfig } from '../../constants/oauth.js'
import type { LLMAdapter } from '../../types/llm.js'
import { isDebugToStdErr, logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy, isInternalBuild, parseEnvNumber } from '../../services/infra/envUtils.js'
import { anthropicProviderAdapter } from './anthropicProviderAdapter.js'
import { googleProviderAdapter } from './googleProviderAdapter.js'
import { OpenAIProviderAdapter } from './openAIProviderAdapter.js'
import { OpenAICodexResponsesProviderAdapter } from './openAICodexResponsesProviderAdapter.js'
import { OpenAIResponsesProviderAdapter } from './openAIResponsesProviderAdapter.js'
import { isOfficialAnthropicApiBaseUrl, resolveApiBaseUrl } from './baseUrlResolution.js'

/**
 * 不同客户端类型的环境变量：
 *
 * 直接 API：
 * - ZY_API_KEY：直接 API 访问所需
 */

function createStderrLogger(): {
  error: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  info: (msg: string, ...args: unknown[]) => void
  debug: (msg: string, ...args: unknown[]) => void
} {
  return {
    error: (msg: string, ...args: unknown[]) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg: string, ...args: unknown[]) => console.error('[SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg: string, ...args: unknown[]) => console.error('[SDK INFO]', msg, ...args),
    debug: (msg: string, ...args: unknown[]) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[SDK DEBUG]', msg, ...args),
  }
}
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const containerId = process.env.ZY_CODE_CONTAINER_ID
  const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: {
    [key: string]: string
  } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Zy-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId
      ? {
          'x-zy-remote-container-id': containerId,
        }
      : {}),
    ...(remoteSessionId
      ? {
          'x-zy-remote-session-id': remoteSessionId,
        }
      : {}),
    // SDK 消费者可以通过此标识在 SDK 请求上设置他们的 app/library，用于后端分析
    ...(clientApp
      ? {
          'x-client-app': clientApp,
        }
      : {}),
  }

  // 记录 API 客户端配置，用于 HFI 调试
  logForDebugging(
    `[API:request] Creating client, ZY_CODE_CUSTOM_HEADERS present: ${!!process.env.ZY_CODE_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders.Authorization}`,
  )

  // 如果通过环境变量启用了额外保护 header
  const additionalProtectionEnabled = isEnvTruthy(process.env.ZY_CODE_ADDITIONAL_PROTECTION)
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  // ── Registry 驱动的 provider ──────────────────────────────────────────
  // 处理 env-or-default（dashscope、zhipu、kimi）、预配置（deepseek、siliconflow 等）和
  // generic provider；它们共享同一套 client 创建逻辑。
  const context = resolveModelRequestContext(model)
  const { provider: apiProvider, authProfile } = context
  const authProvider = authProfile ?? apiProvider
  const resolvedBaseURL = resolveApiBaseUrl({ context })

  // 先创建 Anthropic API-key fallback；anthropicProviderAdapter 会优先识别该连接的
  // Anthropic OAuth，并在订阅路径上忽略这个 fallback client。
  await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession(), authProvider)
  const resolvedFetch = buildFetch(fetchOverride, source, apiProvider)
  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseEnvNumber(process.env.API_TIMEOUT_MS) ?? 600 * 1000,
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }),
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  } as ClientOptions & { fetchOptions: ReturnType<typeof getProxyFetchOptions> }
  // 处理有默认值的 provider（endpointType 包含 'default'）
  if (!isCustomEndpointProvider(apiProvider) && resolvedBaseURL) {
    const resolvedApiKey = getApiKey(authProvider)
    const providerHeaders: Record<string, string> = {}
    if (defaultHeaders['User-Agent']) {
      providerHeaders['User-Agent'] = defaultHeaders['User-Agent']
    }
    const providerConfig = {
      apiKey: resolvedApiKey,
      // 显式置空 authToken，避免 SDK 自动读取 ANTHROPIC_AUTH_TOKEN
      // 与非 Anthropic provider 的 apiKey 鉴权冲突
      authToken: null,
      baseURL: resolvedBaseURL,
      defaultHeaders: providerHeaders,
      maxRetries: ARGS.maxRetries,
      timeout: ARGS.timeout,
      dangerouslyAllowBrowser: ARGS.dangerouslyAllowBrowser,
      // 传入代理 / mTLS 配置，否则 Windows 下走代理的网络环境会直连超时
      fetchOptions: getProxyFetchOptions(),
      ...(ARGS.fetch && { fetch: ARGS.fetch }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    } as unknown as ClientOptions
    return new Anthropic(providerConfig)
  }

  // 本地推理引擎（ollama、lmstudio、llamacpp、nim 等）
  if (isCustomEndpointProvider(apiProvider)) {
    const customApiKey = apiKey || process.env.LLM_API_KEY || getApiKey(authProvider)
    const customEndpointHeaders: Record<string, string> = {}
    if (defaultHeaders['User-Agent']) {
      customEndpointHeaders['User-Agent'] = defaultHeaders['User-Agent']
    }
    const providerAnthropicConfig = {
      apiKey: customApiKey,
      // 显式置空 authToken，避免 SDK 自动读取 ANTHROPIC_AUTH_TOKEN
      authToken: null,
      baseURL: resolvedBaseURL,
      defaultHeaders: customEndpointHeaders,
      maxRetries: ARGS.maxRetries,
      timeout: ARGS.timeout,
      dangerouslyAllowBrowser: ARGS.dangerouslyAllowBrowser,
      // 传入代理 / mTLS 配置，与默认 Anthropic 客户端行为保持一致
      fetchOptions: getProxyFetchOptions(),
      ...(ARGS.fetch && { fetch: ARGS.fetch }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    } as unknown as ClientOptions
    return new Anthropic(providerAnthropicConfig)
  }

  // 根据可用的 token 确定认证方式
  const clientConfig = {
    apiKey: apiKey || getApiKey(authProvider),
    authToken: undefined,
    // 使用 staging OAuth 时从 OAuth 配置设置 baseURL
    ...(isInternalBuild() && isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? {
          baseURL: getOauthConfig().BASE_API_URL,
        }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && {
      logger: createStderrLogger(),
    }),
  } as unknown as ClientOptions
  return new Anthropic(clientConfig)
}

// ============================================================================
// OpenAI SDK 客户端创建
// ============================================================================

/**
 * 创建 OpenAI SDK 客户端实例。
 *
 * 与 getAnthropicClient 共享相同的基础设施：
 * - 共享 headers（X-Zy-Code-Session-Id、User-Agent、ZY_CODE_CUSTOM_HEADERS 等）
 * - baseUrl 优先级：传入值 → provider-specific env → OPENAI_BASE_URL → LLM_BASE_URL
 *   → settings.json baseUrl → registry openai-chat 端点 → api.openai.com/v1
 * - proxy 配置（getProxyFetchOptions）
 * - debug logger（isDebugToStdErr）
 * - timeout 配置（API_TIMEOUT_MS）
 */
export async function getOpenAIClient(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
  maxRetries?: number
  model?: string
}): Promise<OpenAI> {
  const context = resolveModelRequestContext(options?.model)
  const { provider: apiProvider, authProfile } = context
  const authProvider = authProfile ?? apiProvider

  // ── Headers（与 getAnthropicClient 保持一致）──────────────────────────────────
  const containerId = process.env.ZY_CODE_CONTAINER_ID
  const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Zy-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-zy-remote-container-id': containerId } : {}),
    ...(remoteSessionId ? { 'x-zy-remote-session-id': remoteSessionId } : {}),
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // ── API Key ────────────────────────────────────────────────────────────
  let resolvedApiKey = options?.apiKey
  if (!resolvedApiKey) {
    // custom-endpoint provider（ollama 等）优先取 LLM_API_KEY
    if (isCustomEndpointProvider(apiProvider)) {
      resolvedApiKey = process.env.LLM_API_KEY || getApiKey(authProvider) || undefined
    } else {
      resolvedApiKey = getApiKey(authProvider) ?? undefined
    }
  }

  // ── Base URL（与 getAnthropicClient registry-driven 段保持一致）──────────────
  const resolvedBaseURL =
    resolveApiBaseUrl({ context, explicitBaseUrl: options?.baseURL }) ?? 'https://api.openai.com/v1'

  const timeout = options?.timeout ?? parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10)

  logForDebugging(
    `[API:request] Creating OpenAI client, baseURL=${resolvedBaseURL}, ` +
      `provider=${apiProvider}, customHeaders=${!!process.env.ZY_CODE_CUSTOM_HEADERS}`,
  )

  const openAIFetch = buildProxiedFetch()
  return new OpenAI({
    apiKey: resolvedApiKey || '',
    baseURL: resolvedBaseURL,
    timeout,
    maxRetries: options?.maxRetries ?? 3,
    defaultHeaders,
    ...(openAIFetch && { fetch: openAIFetch }),
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  })
}

// ============================================================================
// Google Generative AI SDK 客户端创建
// ============================================================================

/**
 * 创建 Google Generative AI SDK 客户端实例。
 *
 * 与 getOpenAIClient / getAnthropicClient 共享相同的基础设施：
 * - 共享 headers（X-Zy-Code-Session-Id、User-Agent 等）
 * - baseUrl 优先级：传入值 → provider-specific env → GOOGLE_BASE_URL → LLM_BASE_URL
 *   → settings.json baseUrl → registry google 格式端点 → generativelanguage.googleapis.com
 */
export async function getGoogleClient(options?: {
  apiKey?: string
  baseURL?: string
  model?: string
}): Promise<{ client: GoogleGenerativeAI; baseURL: string }> {
  const context = resolveModelRequestContext(options?.model)
  const { provider: apiProvider, authProfile } = context
  const authProvider = authProfile ?? apiProvider

  // ── API Key ────────────────────────────────────────────────────────────
  let resolvedApiKey = options?.apiKey
  if (!resolvedApiKey) {
    if (isCustomEndpointProvider(apiProvider)) {
      resolvedApiKey = process.env.LLM_API_KEY || getApiKey(authProvider) || undefined
    } else {
      resolvedApiKey = getApiKey(authProvider) ?? undefined
    }
  }
  if (!resolvedApiKey) {
    throw new Error('Google API key not found. Set GOOGLE_API_KEY or configure in onboarding.')
  }

  // ── Base URL ───────────────────────────────────────────────────────────
  const resolvedBaseURL =
    resolveApiBaseUrl({ context, explicitBaseUrl: options?.baseURL }) ??
    'https://generativelanguage.googleapis.com/v1beta'

  logForDebugging(
    `[API:request] Creating Google client, baseURL=${resolvedBaseURL}, ` +
      `provider=${apiProvider}`,
  )

  const client = new GoogleGenerativeAI(resolvedApiKey)
  return { client, baseURL: resolvedBaseURL }
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
  provider?: string,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession, provider))
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
}
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ZY_CODE_CUSTOM_HEADERS
  if (!customHeadersEnv) {
    return customHeaders
  }

  // 按换行符分割以支持多个 header
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)
  for (const headerString of headerStrings) {
    if (!headerString.trim()) {
      continue
    }

    // 解析 "Name: Value" 格式的 header（curl 风格）。在第一个 `:` 处分割
    // 然后修剪空白——避免在畸形长 header 行上出现正则回溯
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) {
      continue
    }
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }
  return customHeaders
}
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
  provider: string,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers((init as RequestInit | undefined)?.headers)
    let requestUrl: string | undefined
    try {
      requestUrl = input instanceof Request ? input.url : String(input)
    } catch {
      // URL 仅用于日志与官方端点判断，解析失败不能阻断请求。
    }
    // 生成客户端侧请求 ID，以便超时（不返回服务器请求 ID）
    // 仍能被 API 团队与服务器日志关联。
    // 想要自行追踪 ID 的调用方可以预设此 header
    if (
      provider === 'anthropic' &&
      requestUrl &&
      isOfficialAnthropicApiBaseUrl(requestUrl) &&
      !headers.has(CLIENT_REQUEST_ID_HEADER)
    ) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(requestUrl ?? '').pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // 绝不让日志导致 fetch 崩溃
    }
    return inner(input, {
      ...init,
      headers,
    })
  }
}

/**
 * 统一的 LLM Adapter 工厂函数（使用 llm.ts 中立标准类型）。
 * 根据同一次解析得到的 apiFormat 与 OAuth provider ID 选择 Adapter。
 * 调用方使用 llm.ts 类型，完全不依赖任何 SDK。
 *
 * @param options.anthropicClient 可选。Anthropic SDK client 实例，用于复用
 *   withRetry 等基础设施提供的 retry/auth 配置。仅在 Anthropic 路径生效。
 *   未提供时 anthropicProviderAdapter 会自取 client。
 * @param options.model 当前请求模型。双格式 provider 可按模型选择不同 adapter。
 */
export function getLLMAdapter(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
  anthropicClient?: Anthropic
  model?: string
}): LLMAdapter {
  const context = resolveModelRequestContext(options?.model)
  return createAdapterFromContext(context, options?.anthropicClient)
}

/**
 * 为一次重试周期创建协议匹配的 adapter。
 * OAuth 并非 Anthropic 专属：xAI、OpenAI Codex、GitHub Copilot 仍按命名连接进入
 * 各自的 OpenAI 格式 adapter。这里只在最终协议确为 Anthropic 时预创建 Anthropic
 * SDK client，避免其他协议读取无关认证与端点。
 */
export async function createLLMAdapter(options: {
  model: string
  maxRetries: number
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<LLMAdapter> {
  const context = resolveModelRequestContext(options.model)
  const anthropicClient =
    context.apiFormat === 'anthropic'
      ? await getAnthropicClient({
          maxRetries: options.maxRetries,
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.source,
        })
      : undefined
  return createAdapterFromContext(context, anthropicClient)
}

function createAdapterFromContext(
  context: ReturnType<typeof resolveModelRequestContext>,
  anthropicClient?: Anthropic,
): LLMAdapter {
  const { provider: apiProvider, authProfile, apiFormat } = context

  // 大多数 OAuth provider（xAI、Copilot、Anthropic）可沿用其 apiFormat adapter；
  // Codex 订阅后端的端点和请求约束不同，因此必须在通用 OpenAI 分派前单独识别。
  // 同一个 openai provider 使用 API key 时仍走 api.openai.com，不受此分支影响。
  if (getOAuthProviderIdForConnection(authProfile ?? apiProvider) === 'openai-codex') {
    return new OpenAICodexResponsesProviderAdapter()
  }

  switch (apiFormat) {
    case 'google':
      return new googleProviderAdapter()
    case 'openai-responses':
      return new OpenAIResponsesProviderAdapter()
    case 'openai-chat':
      return new OpenAIProviderAdapter()
    case 'anthropic':
      return new anthropicProviderAdapter(anthropicClient)
  }
}
