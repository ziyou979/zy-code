import { randomUUID } from 'node:crypto'
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { getProviderForModel } from 'src/services/model/model.js'
import { getProviderEntry } from 'src/services/model/providerRegistry.js'
import {
  getSettingsBaseUrl,
  isAnthropicBaseUrl,
  isAnthropicProvider,
  isCustomEndpointProvider,
  isEnvEndpointProvider,
  isGoogleProvider,
  isOpenAIProvider,
} from 'src/services/model/providers.js'
import { getApiKey, getApiKeyFromApiKeyHelper } from 'src/services/auth/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { getOauthConfig } from '../../constants/oauth.js'
import type { LLMAdapter } from '../../types/llm.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy, isInternalBuild, parseEnvNumber } from '../../utils/envUtils.js'
import { AnthropicProviderAdapter } from './anthropicProviderAdapter.js'
import { GoogleProviderAdapter } from './googleProviderAdapter.js'
import { OpenAIProviderAdapter } from './openAIProviderAdapter.js'

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
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId
      ? {
          'x-claude-remote-container-id': containerId,
        }
      : {}),
    ...(remoteSessionId
      ? {
          'x-claude-remote-session-id': remoteSessionId,
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

  // ── Registry-driven providers ──────────────────────────────────────────
  // Handles env-or-default (dashscope, zhipu, kimi), preconfigured (deepseek,
  // siliconflow, etc.), and generic — all share the same client creation logic.
  const apiProvider = getProviderForModel(model)
  const registryEntry = getProviderEntry(apiProvider)

  // 始终配置 API 密钥 header（无订阅上下文）
  await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession(), apiProvider)
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
  if (
    registryEntry &&
    (registryEntry.endpointType.includes('default') || apiProvider === 'generic')
  ) {
    const resolvedApiKey = getApiKey(apiProvider)
    let resolvedBaseURL: string | undefined

    // 1. Provider-specific env var (e.g. DASHSCOPE_BASE_URL)
    if (registryEntry.baseUrlEnvVar && process.env[registryEntry.baseUrlEnvVar]) {
      resolvedBaseURL = process.env[registryEntry.baseUrlEnvVar]
    }
    // 2. Generic env vars
    if (!resolvedBaseURL && process.env.ZY_CODE_BASE_URL) {
      resolvedBaseURL = process.env.ZY_CODE_BASE_URL
    }
    if (!resolvedBaseURL && process.env.LLM_BASE_URL) {
      resolvedBaseURL = process.env.LLM_BASE_URL
    }
    // 3. settings.json baseUrl（适用于所有 provider）
    if (!resolvedBaseURL) {
      resolvedBaseURL = getSettingsBaseUrl(apiProvider) ?? undefined
    }
    // 4. Onboarding config (configuredBaseUrl) — 向后兼容
    // 仅当 configuredProvider 与当前 apiProvider 匹配时使用，
    // 避免跨 provider 残留的旧 URL（如 llama.cpp 的 localhost）覆盖当前 provider 的默认 URL
    if (!resolvedBaseURL) {
      try {
        const { getGlobalConfig } = await import('../config/config.js')
        const cfg = getGlobalConfig()
        if (cfg.configuredProvider === apiProvider) {
          resolvedBaseURL = cfg.configuredBaseUrl
        }
      } catch {
        // config not ready
      }
    }
    // 5. Registry defaults（根据当前格式选择对应端点）
    if (!resolvedBaseURL && registryEntry.defaultBaseUrls) {
      const format = isAnthropicProvider(apiProvider, model) ? 'anthropic' : 'openai'
      resolvedBaseURL =
        registryEntry.defaultBaseUrls[format] ?? registryEntry.defaultBaseUrls.openai
    }

    if (resolvedBaseURL) {
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
  }

  // 本地推理引擎（ollama、lmstudio、llamacpp、nim 等）
  if (isCustomEndpointProvider(apiProvider) && registryEntry) {
    // 优先级：环境变量 > settings.json > onboarding 配置 > registry 默认值
    let customBaseURL: string | undefined
    if (process.env.LLM_BASE_URL) {
      customBaseURL = process.env.LLM_BASE_URL
    }
    if (!customBaseURL) {
      customBaseURL = getSettingsBaseUrl(apiProvider) ?? undefined
    }
    if (!customBaseURL) {
      try {
        const { getGlobalConfig } = await import('../config/config.js')
        const cfg = getGlobalConfig()
        // 仅当 configuredBaseUrl 属于当前 provider 时才使用，
        // 避免之前配置的其他 provider（如 llama.cpp）的 URL 残留覆盖
        if (cfg.configuredProvider === apiProvider) {
          customBaseURL = cfg.configuredBaseUrl
        }
      } catch {
        // config not ready
      }
    }
    if (!customBaseURL && registryEntry.defaultBaseUrls) {
      const format = isAnthropicProvider(apiProvider, model) ? 'anthropic' : 'openai'
      customBaseURL = registryEntry.defaultBaseUrls[format] ?? registryEntry.defaultBaseUrls.openai
    }

    const customApiKey = apiKey || process.env.LLM_API_KEY || getApiKey(apiProvider)
    const customEndpointHeaders: Record<string, string> = {}
    if (defaultHeaders['User-Agent']) {
      customEndpointHeaders['User-Agent'] = defaultHeaders['User-Agent']
    }
    const providerAnthropicConfig = {
      apiKey: customApiKey,
      // 显式置空 authToken，避免 SDK 自动读取 ANTHROPIC_AUTH_TOKEN
      authToken: null,
      baseURL: customBaseURL,
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
    apiKey: apiKey || getApiKey(apiProvider),
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
 * - 共享 headers（X-Claude-Code-Session-Id、User-Agent、ZY_CODE_CUSTOM_HEADERS 等）
 * - baseUrl 优先级：传入值 → provider-specific env → OPENAI_BASE_URL → LLM_BASE_URL
 *   → settings.json baseUrl → (provider 匹配时) configuredBaseUrl → registry.defaultBaseUrls.openai → api.openai.com/v1
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
  const apiProvider = getProviderForModel(options?.model)
  const registryEntry = getProviderEntry(apiProvider)

  // ── Headers（与 getAnthropicClient 保持一致）──────────────────────────────────
  const containerId = process.env.ZY_CODE_CONTAINER_ID
  const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
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
      resolvedApiKey = process.env.LLM_API_KEY || getApiKey(apiProvider) || undefined
    } else {
      resolvedApiKey = getApiKey(apiProvider) ?? undefined
    }
  }

  // ── Base URL（与 getAnthropicClient registry-driven 段保持一致）──────────────
  let resolvedBaseURL = options?.baseURL
  if (!resolvedBaseURL) {
    // 1. Provider-specific env var (e.g. DASHSCOPE_BASE_URL)
    if (registryEntry?.baseUrlEnvVar && process.env[registryEntry.baseUrlEnvVar]) {
      resolvedBaseURL = process.env[registryEntry.baseUrlEnvVar]
    }
    // 2. OpenAI / Generic env vars
    if (!resolvedBaseURL && process.env.OPENAI_BASE_URL) {
      resolvedBaseURL = process.env.OPENAI_BASE_URL
    }
    if (!resolvedBaseURL && process.env.LLM_BASE_URL) {
      resolvedBaseURL = process.env.LLM_BASE_URL
    }
    // 3. settings.json baseUrl（适用于所有 provider）
    if (!resolvedBaseURL) {
      resolvedBaseURL = getSettingsBaseUrl(apiProvider) ?? undefined
    }
    // 4. Onboarding config (configuredBaseUrl) — 向后兼容
    // 仅当 configuredProvider 与当前 apiProvider 匹配时使用，
    // 避免跨 provider 残留的旧 URL 覆盖当前 provider 的默认 URL
    if (!resolvedBaseURL) {
      try {
        const { getGlobalConfig } = await import('../config/config.js')
        const cfg = getGlobalConfig()
        if (cfg.configuredProvider === apiProvider) {
          resolvedBaseURL = cfg.configuredBaseUrl
        }
      } catch {
        // config not ready
      }
    }
    // 5. Registry defaults
    if (!resolvedBaseURL && registryEntry?.defaultBaseUrls) {
      resolvedBaseURL = registryEntry.defaultBaseUrls.openai
    }
    // 6. Fallback
    if (!resolvedBaseURL) {
      resolvedBaseURL = 'https://api.openai.com/v1'
    }
  }

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
 * - 共享 headers（X-Claude-Code-Session-Id、User-Agent 等）
 * - baseUrl 优先级：传入值 → provider-specific env → GOOGLE_BASE_URL → LLM_BASE_URL
 *   → settings.json baseUrl → (provider 匹配时) configuredBaseUrl → registry.defaultBaseUrls.google → generativelanguage.googleapis.com
 */
export async function getGoogleClient(options?: {
  apiKey?: string
  baseURL?: string
  model?: string
}): Promise<{ client: GoogleGenerativeAI; baseURL: string }> {
  const apiProvider = getProviderForModel(options?.model)
  const registryEntry = getProviderEntry(apiProvider)

  // ── API Key ────────────────────────────────────────────────────────────
  let resolvedApiKey = options?.apiKey
  if (!resolvedApiKey) {
    if (isCustomEndpointProvider(apiProvider)) {
      resolvedApiKey = process.env.LLM_API_KEY || getApiKey(apiProvider) || undefined
    } else {
      resolvedApiKey = getApiKey(apiProvider) ?? undefined
    }
  }
  if (!resolvedApiKey) {
    throw new Error('Google API key not found. Set GOOGLE_API_KEY or configure in onboarding.')
  }

  // ── Base URL ───────────────────────────────────────────────────────────
  let resolvedBaseURL = options?.baseURL
  if (!resolvedBaseURL) {
    // 1. Provider-specific env var
    if (registryEntry?.baseUrlEnvVar && process.env[registryEntry.baseUrlEnvVar]) {
      resolvedBaseURL = process.env[registryEntry.baseUrlEnvVar]
    }
    // 2. Generic env vars
    if (!resolvedBaseURL && process.env.GOOGLE_BASE_URL) {
      resolvedBaseURL = process.env.GOOGLE_BASE_URL
    }
    if (!resolvedBaseURL && process.env.LLM_BASE_URL) {
      resolvedBaseURL = process.env.LLM_BASE_URL
    }
    // 3. settings.json baseUrl（适用于所有 provider）
    if (!resolvedBaseURL) {
      resolvedBaseURL = getSettingsBaseUrl(apiProvider) ?? undefined
    }
    // 4. Onboarding config (configuredBaseUrl) — 向后兼容
    // 仅当 configuredProvider 与当前 apiProvider 匹配时使用，
    // 避免跨 provider 残留的旧 URL 覆盖当前 provider 的默认 URL
    if (!resolvedBaseURL) {
      try {
        const { getGlobalConfig } = await import('../config/config.js')
        const cfg = getGlobalConfig()
        if (cfg.configuredProvider === apiProvider) {
          resolvedBaseURL = cfg.configuredBaseUrl
        }
      } catch {
        // config not ready
      }
    }
    // 5. Registry defaults
    if (!resolvedBaseURL && registryEntry?.defaultBaseUrls) {
      resolvedBaseURL = registryEntry.defaultBaseUrls.google
    }
    // 6. Fallback
    if (!resolvedBaseURL) {
      resolvedBaseURL = 'https://generativelanguage.googleapis.com/v1beta'
    }
  }

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
  // 仅发送到直接 API——Bedrock/Vertex/Foundry 不记录此
  // 未知 header 有被严格代理拒绝的风险（inc-4029 类）
  const injectClientRequestId = provider === 'anthropic' && isAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers((init as RequestInit | undefined)?.headers)
    // 生成客户端侧请求 ID，以便超时（不返回服务器请求 ID）
    // 仍能被 API 团队与服务器日志关联。
    // 想要自行追踪 ID 的调用方可以预设此 header
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
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
 * 构建 OpenAI SDK 的 fetch 覆盖，注入代理 / mTLS 选项。
 * OpenAI SDK 不支持 fetchOptions，故通过 fetch 覆盖实现，
 * 与 Anthropic SDK 的 getProxyFetchOptions 行为对齐。
 * 无代理 / mTLS 配置时返回 undefined，交由 SDK 使用默认 fetch。
 */
function buildProxiedFetch():
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined {
  const proxyOpts = getProxyFetchOptions()
  if (Object.keys(proxyOpts).length === 0) {
    return undefined
  }
  const inner = globalThis.fetch
  // 代理选项（dispatcher/proxy/tls）是平台扩展，非标准 RequestInit
  return (input, init) => inner(input, { ...init, ...proxyOpts } as unknown as RequestInit)
}

/**
 * 统一的 LLM Adapter 工厂函数（使用 llm.ts 中立标准类型）。
 * 根据当前 provider 自动选择对应的 Adapter 实现。
 * 调用方使用 llm.ts 类型，完全不依赖任何 SDK。
 *
 * @param options.anthropicClient 可选。Anthropic SDK client 实例，用于复用
 *   withRetry 等基础设施提供的 retry/auth 配置。仅在 Anthropic 路径生效。
 *   未提供时 AnthropicProviderAdapter 会自取 client。
 * @param options.model 当前请求模型。双格式 provider 可按模型选择不同 adapter。
 */
export function getLLMAdapter(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
  anthropicClient?: Anthropic
  model?: string
}): LLMAdapter {
  const apiProvider = getProviderForModel(options?.model)
  const model = options?.model

  // Google 原生格式优先检查（最具体）
  if (isGoogleProvider(apiProvider, model)) {
    return new GoogleProviderAdapter()
  }

  if (isOpenAIProvider(apiProvider, model)) {
    // 客户端创建委托给 getOpenAIClient()（懒加载），不再手动传参
    return new OpenAIProviderAdapter()
  }

  if (isAnthropicProvider(apiProvider, model)) {
    return new AnthropicProviderAdapter(options?.anthropicClient)
  }

  // 兜底：所有已知 provider 均已按 effective format 分派，此处不可达
  return new AnthropicProviderAdapter(options?.anthropicClient)
}
