import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { getApiKey, getApiKeyFromApiKeyHelper } from 'src/utils/auth.js';
import { getUserAgent } from 'src/utils/http.js';
import { getAPIProvider, isAnthropicBaseUrl, isCustomEndpointProvider, isEnvOrDefaultProvider, isOpenAIProvider, isPreconfiguredEndpointProvider } from 'src/utils/model/providers.js';
import { getProviderEntry } from 'src/utils/model/providerRegistry.js';
import { getProxyFetchOptions } from 'src/utils/proxy.js';
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js';
import { getOauthConfig } from '../../constants/oauth.js';
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js';
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js';
import type { LLMAdapter } from '../../types/llm.js';
import { AnthropicProviderAdapter } from './AnthropicProviderAdapter.js';
import { OpenAIProviderAdapter } from './OpenAIProviderAdapter.js';

/**
 * 不同客户端类型的环境变量：
 *
 * 直接 API：
 * - ZY_API_KEY：直接 API 访问所需
 */

function createStderrLogger(): any {
  return {
    error: (msg, ...args) =>
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    console.error('[SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    console.error('[SDK DEBUG]', msg, ...args)
  };
}
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source
}: {
  apiKey?: string;
  maxRetries: number;
  model?: string;
  fetchOverride?: ClientOptions['fetch'];
  source?: string;
}): Promise<Anthropic> {
  const containerId = process.env.ZY_CODE_CONTAINER_ID;
  const remoteSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID;
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
  const customHeaders = getCustomHeaders();
  const defaultHeaders: {
    [key: string]: string;
  } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? {
      'x-claude-remote-container-id': containerId
    } : {}),
    ...(remoteSessionId ? {
      'x-claude-remote-session-id': remoteSessionId
    } : {}),
    // SDK 消费者可以通过此标识在 SDK 请求上设置他们的 app/library，用于后端分析
    ...(clientApp ? {
      'x-client-app': clientApp
    } : {})
  };

  // 记录 API 客户端配置，用于 HFI 调试
  logForDebugging(`[API:request] Creating client, ZY_CODE_CUSTOM_HEADERS present: ${!!process.env.ZY_CODE_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`);

  // 如果通过环境变量启用了额外保护 header
  const additionalProtectionEnabled = isEnvTruthy(process.env.ZY_CODE_ADDITIONAL_PROTECTION);
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true';
  }

  // 始终配置 API 密钥 header（无订阅上下文）
  await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession());
  const resolvedFetch = buildFetch(fetchOverride, source);
  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true
    }) as any,
    ...(resolvedFetch && {
      fetch: resolvedFetch
    })
  } as any;
  // ── Registry-driven providers ──────────────────────────────────────────
  // Handles env-or-default (dashscope, zhipu, kimi), preconfigured (deepseek,
  // siliconflow, etc.), and generic — all share the same client creation logic.
  const apiProvider = getAPIProvider();
  const registryEntry = getProviderEntry(apiProvider);

  if (registryEntry && (isEnvOrDefaultProvider(apiProvider) || isPreconfiguredEndpointProvider(apiProvider) || apiProvider === 'generic')) {
    const resolvedApiKey = getApiKey();
    let resolvedBaseURL: string | undefined;

    // 1. Provider-specific env var (e.g. DASHSCOPE_BASE_URL)
    if (registryEntry.baseUrlEnvVar && process.env[registryEntry.baseUrlEnvVar]) {
      resolvedBaseURL = process.env[registryEntry.baseUrlEnvVar];
    }
    // 2. Generic env vars
    if (!resolvedBaseURL && process.env.ANTHROPIC_BASE_URL) {
      resolvedBaseURL = process.env.ANTHROPIC_BASE_URL;
    }
    if (!resolvedBaseURL && process.env.LLM_BASE_URL) {
      resolvedBaseURL = process.env.LLM_BASE_URL;
    }
    // 3. Onboarding config (configuredBaseUrl)
    if (!resolvedBaseURL) {
      try {
        const { getGlobalConfig } = await import('../../utils/config.js');
        resolvedBaseURL = getGlobalConfig().configuredBaseUrl;
      } catch {
        // config not ready
      }
    }
    // 4. Registry defaults (use openai format as default)
    if (!resolvedBaseURL && registryEntry.defaultBaseUrls) {
      resolvedBaseURL = registryEntry.defaultBaseUrls.openai;
    }

    if (resolvedBaseURL) {
      const providerHeaders: Record<string, string> = {};
      if (defaultHeaders['User-Agent']) {
        providerHeaders['User-Agent'] = defaultHeaders['User-Agent'];
      }
      const providerConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: resolvedApiKey,
        baseURL: resolvedBaseURL,
        defaultHeaders: providerHeaders,
        maxRetries: ARGS.maxRetries,
        timeout: ARGS.timeout,
        dangerouslyAllowBrowser: ARGS.dangerouslyAllowBrowser,
        ...(ARGS.fetch && { fetch: ARGS.fetch }),
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      };
      return new Anthropic(providerConfig);
    }
  }

  // 本地推理引擎（ollama、lmstudio、llamacpp、nvidia-nim 等）
  if (isCustomEndpointProvider(apiProvider) && registryEntry) {
    // 优先级：环境变量 > onboarding 配置 > registry 默认值
    let customBaseURL: string | undefined;
    if (process.env.LLM_BASE_URL) {
      customBaseURL = process.env.LLM_BASE_URL;
    } else {
      try {
        const { getGlobalConfig } = await import('../../utils/config.js');
        customBaseURL = getGlobalConfig().configuredBaseUrl;
      } catch {
        // config not ready
      }
    }
    if (!customBaseURL) {
      customBaseURL = registryEntry.defaultBaseUrls?.openai;
    }

    const customApiKey = apiKey || process.env.LLM_API_KEY || getApiKey();
    const customEndpointHeaders: Record<string, string> = {};
    if (defaultHeaders['User-Agent']) {
      customEndpointHeaders['User-Agent'] = defaultHeaders['User-Agent'];
    }
    const providerAnthropicConfig: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: customApiKey,
      baseURL: customBaseURL,
      defaultHeaders: customEndpointHeaders,
      maxRetries: ARGS.maxRetries,
      timeout: ARGS.timeout,
      dangerouslyAllowBrowser: ARGS.dangerouslyAllowBrowser,
      ...(ARGS.fetch && { fetch: ARGS.fetch }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    };
    return new Anthropic(providerAnthropicConfig);
  }

  // 根据可用的 token 确定认证方式
  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: apiKey || getApiKey(),
    authToken: undefined,
    // 使用 staging OAuth 时从 OAuth 配置设置 baseURL
    ...(isInternalBuild() && isEnvTruthy(process.env.USE_STAGING_OAUTH) ? {
      baseURL: getOauthConfig().BASE_API_URL
    } : {}),
    ...ARGS,
    ...(isDebugToStdErr() && {
      logger: createStderrLogger()
    })
  };
  return new Anthropic(clientConfig);
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
 *   → configuredBaseUrl → registry.defaultBaseUrls.openai → api.openai.com/v1
 * - proxy 配置（getProxyFetchOptions）
 * - debug logger（isDebugToStdErr）
 * - timeout 配置（API_TIMEOUT_MS）
 */
export async function getOpenAIClient(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
  maxRetries?: number
}): Promise<OpenAI> {
  const apiProvider = getAPIProvider()
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
      resolvedApiKey = process.env.LLM_API_KEY || getApiKey()
    } else {
      resolvedApiKey = getApiKey()
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
    // 3. Onboarding config (configuredBaseUrl)
    if (!resolvedBaseURL) {
      try {
        const { getGlobalConfig } = await import('../../utils/config.js')
        resolvedBaseURL = getGlobalConfig().configuredBaseUrl
      } catch {
        // config not ready
      }
    }
    // 4. Registry defaults
    if (!resolvedBaseURL && registryEntry?.defaultBaseUrls) {
      resolvedBaseURL = registryEntry.defaultBaseUrls.openai
    }
    // 5. Fallback
    if (!resolvedBaseURL) {
      resolvedBaseURL = 'https://api.openai.com/v1'
    }
  }

  const timeout = options?.timeout
    ?? parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10)

  logForDebugging(
    `[API:request] Creating OpenAI client, baseURL=${resolvedBaseURL}, ` +
    `provider=${apiProvider}, customHeaders=${!!process.env.ZY_CODE_CUSTOM_HEADERS}`,
  )

  return new OpenAI({
    apiKey: resolvedApiKey || '',
    baseURL: resolvedBaseURL,
    timeout,
    maxRetries: options?.maxRetries ?? 3,
    defaultHeaders,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  })
}

async function configureApiKeyHeaders(headers: Record<string, string>, isNonInteractiveSession: boolean): Promise<void> {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || (await getApiKeyFromApiKeyHelper(isNonInteractiveSession));
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
}
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {};
  const customHeadersEnv = process.env.ZY_CODE_CUSTOM_HEADERS;
  if (!customHeadersEnv) return customHeaders;

  // 按换行符分割以支持多个 header
  const headerStrings = customHeadersEnv.split(/\n|\r\n/);
  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue;

    // 解析 "Name: Value" 格式的 header（curl 风格）。在第一个 `:` 处分割
    // 然后修剪空白——避免在畸形长 header 行上出现正则回溯
    const colonIdx = headerString.indexOf(':');
    if (colonIdx === -1) continue;
    const name = headerString.slice(0, colonIdx).trim();
    const value = headerString.slice(colonIdx + 1).trim();
    if (name) {
      customHeaders[name] = value;
    }
  }
  return customHeaders;
}
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id';


function buildFetch(fetchOverride: ClientOptions['fetch'], source: string | undefined): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch;
  // 仅发送到直接 API——Bedrock/Vertex/Foundry 不记录此
  // 未知 header 有被严格代理拒绝的风险（inc-4029 类）
  const injectClientRequestId = getAPIProvider() === 'anthropic' && isAnthropicBaseUrl();
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers((init as any)?.headers);
    // 生成客户端侧请求 ID，以便超时（不返回服务器请求 ID）
    // 仍能被 API 团队与服务器日志关联。
    // 想要自行追踪 ID 的调用方可以预设此 header
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID());
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input);
      const id = headers.get(CLIENT_REQUEST_ID_HEADER);
      logForDebugging(`[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`);
    } catch {
      // 绝不让日志导致 fetch 崩溃
    }
    return (inner as any)(input, {
      ...(init as any),
      headers
    });
  };
}

/**
 * 统一的 LLM Adapter 工厂函数（使用 llm.ts 中立标准类型）。
 * 根据当前 provider 自动选择对应的 Adapter 实现。
 * 调用方使用 llm.ts 类型，完全不依赖任何 SDK。
 *
 * @param options.anthropicClient 可选。Anthropic SDK client 实例，用于复用
 *   withRetry 等基础设施提供的 retry/auth 配置。仅在 Anthropic 路径生效。
 *   未提供时 AnthropicProviderAdapter 会自取 client。
 */
export function getLLMAdapter(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
  anthropicClient?: Anthropic
}): LLMAdapter {
  const apiProvider = getAPIProvider()

  if (isOpenAIProvider(apiProvider)) {
    // 客户端创建委托给 getOpenAIClient()（懒加载），不再手动传参
    return new OpenAIProviderAdapter()
  }

  return new AnthropicProviderAdapter(options?.anthropicClient)
}
