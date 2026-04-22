import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type { GoogleAuth } from 'google-auth-library';
import { getApiKey, getApiKeyFromApiKeyHelper, refreshAndGetAwsCredentials, refreshGcpCredentialsIfNeeded } from 'src/utils/auth.js';
import { getUserAgent } from 'src/utils/http.js';
import { getDefaultHaikuModel } from 'src/utils/model/model.js';
import { getAPIProvider, isAnthropicBaseUrl, isCustomEndpointProvider, isEnvOrDefaultProvider, isOpenAIProvider, isPreconfiguredEndpointProvider } from 'src/utils/model/providers.js';
import { getProviderEntry } from 'src/utils/model/providerRegistry.js';
import { getProxyFetchOptions } from 'src/utils/proxy.js';
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js';
import { getOauthConfig } from '../../constants/oauth.js';
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js';
import { getAWSRegion, getVertexRegionForModel, isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js';
import type { LLMProvider, StandardMessageRequest, StandardResponse, StandardStreamEvent } from './StandardMessageFormat.js';
import { AnthropicProviderAdapter } from './AnthropicProviderAdapter.js';
import { OpenAIProviderAdapter } from './OpenAIProviderAdapter.js';

/**
 * 不同客户端类型的环境变量：
 *
 * 直接 API：
 * - ZY_API_KEY：直接 API 访问所需
 *
 * AWS Bedrock：
 * - 通过 aws-sdk 默认配置 AWS 凭证
 * - AWS_REGION 或 AWS_DEFAULT_REGION：设置所有模型的 AWS 区域（默认：us-east-1）
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION：可选。专门用于 small fast model (Haiku) 的 AWS 区域覆盖
 *
 * Foundry (Azure)：
 * - ANTHROPIC_FOUNDRY_RESOURCE：你的 Azure 资源名称（例如 'my-resource'）
 *   完整端点：https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL：可选。替代 resource，直接提供完整基础 URL
 *   （例如 'https://my-resource.services.ai.azure.com'）
 *
 * 认证（以下方式之一）：
 * - ANTHROPIC_FOUNDRY_API_KEY：你的 Microsoft Foundry API 密钥（如果使用 API 密钥认证）
 * - Azure AD 认证：如果未提供 API 密钥，则使用 DefaultAzureCredential
 *   支持多种认证方式（环境变量、托管标识、Azure CLI 等）
 *   参见：https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI：
 * - CLOUD_ML_REGION：可选。用于所有模型的默认 GCP 区域
 *   如果未在上方指定特定模型区域，则使用此值
 * - ANTHROPIC_VERTEX_PROJECT_ID：必填。你的 GCP 项目 ID
 * - 通过 google-auth-library 配置标准 GCP 凭证
 *
 * 确定区域的优先级：
 * 1. 硬编码的模型特定环境变量
 * 2. 全局 CLOUD_ML_REGION 变量
 * 3. 配置中的默认区域
 * 4. 回退区域 (us-east5)
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
export async function getLLMClient({
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
    'X-Zy-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? {
      'x-zy-remote-container-id': containerId
    } : {}),
    ...(remoteSessionId ? {
      'x-zy-remote-session-id': remoteSessionId
    } : {}),
    // SDK 消费者可以通过此标识在 SDK 请求上设置他们的 app/library，用于后端分析
    ...(clientApp ? {
      'x-client-app': clientApp
    } : {})
  };

  // 记录 API 客户端配置，用于 HFI 调试
  logForDebugging(`[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`);

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
  if (isEnvTruthy(process.env.ZY_CODE_USE_BEDROCK)) {
    const {
      AnthropicBedrock
    } = await import('@anthropic-ai/bedrock-sdk');
    // 如果指定了 Haiku 模型的 AWS 区域覆盖，则使用
    const awsRegion = model === getDefaultHaikuModel() && process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION : getAWSRegion();
    const bedrockArgs: ConstructorParameters<typeof AnthropicBedrock>[0] = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.ZY_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true
      }),
      ...(isDebugToStdErr() && {
        logger: createStderrLogger()
      })
    };

    // 添加 API 密钥认证（如果可用）
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true;
      // 为 Bedrock API 密钥认证添加 Bearer token
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`
      };
    } else if (!isEnvTruthy(process.env.ZY_CODE_SKIP_BEDROCK_AUTH)) {
      // 刷新认证并获取凭证，同时清除缓存
      const cachedCredentials = await refreshAndGetAwsCredentials();
      if (cachedCredentials) {
        (bedrockArgs as any).awsAccessKey = cachedCredentials.accessKeyId;
        (bedrockArgs as any).awsSecretKey = cachedCredentials.secretAccessKey;
        (bedrockArgs as any).awsSessionToken = cachedCredentials.sessionToken;
      }
    }
    // 返回值类型一直是不准确的——这不支持 batching 或 models
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic;
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_FOUNDRY)) {
    const {
      AnthropicFoundry
    } = await import('@anthropic-ai/foundry-sdk' as any) as any;
    // 根据配置确定 Azure AD token provider
    // SDK 默认读取 ANTHROPIC_FOUNDRY_API_KEY
    let azureADTokenProvider: (() => Promise<string>) | undefined;
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.ZY_CODE_SKIP_FOUNDRY_AUTH)) {
        // 测试/代理场景下的模拟 token provider（类似于 Vertex 的模拟 GoogleAuth）
        azureADTokenProvider = () => Promise.resolve('');
      } else {
        // 使用 DefaultAzureCredential 进行真实的 Azure AD 认证
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider
        } = await import('@azure/identity');
        azureADTokenProvider = getBearerTokenProvider(new AzureCredential(), 'https://cognitiveservices.azure.com/.default');
      }
    }
    const foundryArgs: ConstructorParameters<typeof AnthropicFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && {
        azureADTokenProvider
      }),
      ...(isDebugToStdErr() && {
        logger: createStderrLogger()
      })
    };
    // 返回值类型一直是不准确的——这不支持 batching 或 models
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic;
  }
  if (isEnvTruthy(process.env.ZY_CODE_USE_VERTEX)) {
    // 如果配置了 gcpAuthRefresh 且凭证已过期，则刷新 GCP 凭证
    // 这与我们处理 Bedrock 的 AWS 凭证刷新类似
    if (!isEnvTruthy(process.env.ZY_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded();
    }
    const [{
      AnthropicVertex
    }, {
      GoogleAuth
    }] = await Promise.all([import('@anthropic-ai/vertex-sdk'), import('google-auth-library')]);
    // TODO: 缓存 GoogleAuth 实例或 AuthClient 以提升性能
    // 目前每次调用 getLLMClient() 都会创建新的 GoogleAuth 实例
    // 这可能导致重复的认证流程和元数据服务器检查
    // 但是，缓存需要仔细处理：
    // - 凭证刷新/过期
    // - 环境变量变更（GOOGLE_APPLICATION_CREDENTIALS、项目变量等）
    // - 跨请求的认证状态管理
    // 缓存的难点参见：https://github.com/googleapis/google-auth-library-nodejs/issues/390

    // 提供 projectId 作为回退，防止元数据服务器超时
    // google-auth-library 按以下顺序检查项目 ID：
    // 1. 环境变量（GCLOUD_PROJECT、GOOGLE_CLOUD_PROJECT 等）
    // 2. 凭证文件（服务账号 JSON、ADC 文件）
    // 3. gcloud config
    // 4. GCE 元数据服务器（在 GCP 外部会导致 12 秒超时）
    //
    // 仅在用户未配置其他发现方法时设置 projectId
    // 以免干扰其现有的认证配置

    // 按 google-auth-library 相同的顺序检查项目环境变量
    // 参见：https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar = process.env['GCLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT'] || process.env['gcloud_project'] || process.env['google_cloud_project'];

    // 检查凭证文件路径（服务账号或 ADC）
    // 注：同时检查标准和小写变体以确保安全
    // 但我们应验证 google-auth-library 实际检查的是哪些
    const hasKeyFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'] || process.env['google_application_credentials'];
    const googleAuth = isEnvTruthy(process.env.ZY_CODE_SKIP_VERTEX_AUTH) ? {
      // 测试/代理场景下模拟 GoogleAuth
      getClient: () => ({
        getRequestHeaders: () => ({})
      })
    } as unknown as GoogleAuth : new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      // 仅将 ANTHROPIC_VERTEX_PROJECT_ID 作为最后的回退方案
      // 这可以防止在以下情况时出现 12 秒元数据服务器超时：
      // - 未设置项目环境变量 且
      // - 未指定凭证 keyfile 且
      // - ADC 文件存在但缺少 project_id 字段
      //
      // 风险：如果认证项目与 API 目标项目不一致，可能导致计费/审计问题
      // 缓解措施：用户可以设置 GOOGLE_CLOUD_PROJECT 来覆盖
      ...(hasProjectEnvVar || hasKeyFile ? {} : {
        projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID
      })
    });
    const vertexArgs: ConstructorParameters<typeof AnthropicVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && {
        logger: createStderrLogger()
      })
    };
    // 返回值类型一直是不准确的——这不支持 batching 或 models
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic;
  }
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
async function configureApiKeyHeaders(headers: Record<string, string>, isNonInteractiveSession: boolean): Promise<void> {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || (await getApiKeyFromApiKeyHelper(isNonInteractiveSession));
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
}
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {};
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS;
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
 * 统一的 LLM Provider 工厂函数。
 * 根据当前 provider 自动选择对应的 Adapter 实现。
 * 调用方使用 StandardMessageFormat 类型，不依赖任何 SDK。
 */
export function getLLMProvider(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
}): LLMProvider {
  const apiProvider = getAPIProvider()

  if (isOpenAIProvider(apiProvider)) {
    return new OpenAIProviderAdapter({
      apiKey: options?.apiKey,
      baseURL: options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL,
      timeout: options?.timeout,
    })
  }

  return new AnthropicProviderAdapter()
}
