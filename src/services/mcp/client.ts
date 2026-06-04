import { feature } from 'bun:bundle'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  type JSONRPCMessage,
  type ListPromptsResult,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  type ListToolsResult,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import zipObject from 'lodash-es/zipObject.js'
import pMap from 'p-map'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { PRODUCT_URL } from '../../constants/product.js'
import { type Tool, type ToolCallProgress, toolMatchesName } from '../../Tool.js'
import { ListMcpResourcesTool } from '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { type MCPProgress, MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { createMcpAuthTool } from '../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { count } from '../../utils/array.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getZyAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { createDebugLog } from '../../utils/debug.js'

const mcpLog = createDebugLog('mcp')

import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { maybeNotifyIDEConnected } from '../../utils/ide.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { WebSocketTransport } from '../../utils/mcpWebSocketTransport.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { transformResultContent } from './mcpResults.js'
import {
  isMcpSessionExpiredError,
  MAX_MCP_DESCRIPTION_LENGTH,
  McpSessionExpiredError,
} from './mcpShared.js'
import { buildMcpToolName } from './mcpStringUtils.js'
import { callMCPToolWithUrlElicitationRetry, extractToolUseId } from './mcpToolCall.js'
import { normalizeNameForMCP } from './normalization.js'
import { getLoggingSafeMcpBaseUrl } from './utils.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js'))
      .fetchMcpSkillsForClient
  : null

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { clearKeychainCache } from '../../services/secureStorage/macOsKeychainHelpers.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { sleep } from '../../utils/sleep.js'
import { hasMcpDiscoveryButNoToken, wrapFetchWithStepUpDetection, ZyAuthProvider } from './auth.js'
import { WireControlClientTransport } from './BridgeControlTransport.js'
import { getAllMcpConfigs, isMcpServerDisabled } from './config.js'
import { getMcpServerHeaders } from './headersHelper.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'
import { markZyAiMcpConnected } from './zyai.js'

/**
 * 自定义错误类，表示 MCP 工具调用因认证问题失败
 *（例如 OAuth token 过期返回 401）。
 * 此错误应在工具执行层被捕获，以将客户端状态更新为 'needs-auth'。
 */

import { isClaudeInChromeMCPServer } from '../../services/claudeInChrome/common.js'

// 惰性加载：toolRendering.tsx 引入 React/ink；仅在 Zy-in-Chrome MCP 服务器连接时需要
/* eslint-disable @typescript-eslint/no-require-imports */
const ClaudeInChromeToolRendering =
  (): typeof import('../../services/claudeInChrome/toolRendering.js') =>
    require('../../services/claudeInChrome/toolRendering.js')
// 惰性加载：wrapper.tsx → hostAdapter.ts → executor.ts 引入两个原生模块
//（@ant/computer-use-input + @ant/computer-use-swift）。由
// GrowthBook zy_malort_pedway 运行时门控（见 gates.ts）。
const computerUseWrapper = feature('CHICAGO_MCP')
  ? (): typeof import('../../services/computerUse/wrapper.js') =>
      require('../../services/computerUse/wrapper.js')
  : undefined
const isComputerUseMCPServer = feature('CHICAGO_MCP')
  ? (
      require('../../services/computerUse/common.js') as typeof import('../../services/computerUse/common.js')
    ).isComputerUseMCPServer
  : undefined

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 min

type McpAuthCacheData = Record<string, { timestamp: number }>

function getMcpAuthCachePath(): string {
  return join(getZyConfigHomeDir(), 'mcp-needs-auth-cache.json')
}

// 备忘录化，使批量连接期间 N 次并发 isMcpAuthCached() 调用
// 共享单次文件读取而非 N 次读取同一文件。
// 写入时（setMcpAuthCacheEntry）和清除时（clearMcpAuthCache）失效。
// 不使用 lodash memoize 因为我们需要清空整个缓存而非按键删除。
let authCachePromise: Promise<McpAuthCacheData> | null = null

function getMcpAuthCache(): Promise<McpAuthCacheData> {
  if (!authCachePromise) {
    authCachePromise = readFile(getMcpAuthCachePath(), 'utf-8')
      .then((data) => jsonParse(data) as McpAuthCacheData)
      .catch(() => ({}))
  }
  return authCachePromise
}

async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  if (!entry) {
    return false
  }
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS
}

// 通过 promise 链序列化缓存写入，防止同一批次中
// 多个服务器返回 401 时的并发读-改-写竞争
let writeChain = Promise.resolve()

function setMcpAuthCacheEntry(serverId: string): void {
  writeChain = writeChain
    .then(async () => {
      const cache = await getMcpAuthCache()
      cache[serverId] = { timestamp: Date.now() }
      const cachePath = getMcpAuthCachePath()
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, jsonStringify(cache))
      // 使读取缓存失效，以便后续读取能看到新条目。
      // 安全，因为 writeChain 序列化写入：下一次写入的
      // getMcpAuthCache() 调用会重新读取包含此条目的文件。
      authCachePromise = null
    })
    .catch(() => {
      // 尽力写入缓存
    })
}

export function clearMcpAuthCache(): void {
  authCachePromise = null
  void unlink(getMcpAuthCachePath()).catch(() => {
    // 缓存文件可能不存在
  })
}

/**
 * Spread-ready analytics field for the server's base URL. Calls
 * getLoggingSafeMcpBaseUrl once (not twice like the inline ternary it replaces).
 * Typed as AnalyticsMetadata since the URL is query-stripped and safe to log.
 */
function mcpBaseUrlAnalytics(serverRef: ScopedMcpServerConfig): {
  mcpServerBaseUrl?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const url = getLoggingSafeMcpBaseUrl(serverRef)
  return url
    ? {
        mcpServerBaseUrl: url as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }
    : {}
}

/**
 * Shared handler for sse/http/zyai-proxy auth failures during connect:
 * emits zy_mcp_server_needs_auth, caches the needs-auth entry, and returns
 * the needs-auth connection result.
 */
function handleRemoteAuthFailure(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportType: 'sse' | 'http' | 'zyai-proxy',
): MCPServerConnection {
  logEvent('zy_mcp_server_needs_auth', {
    transportType: transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...mcpBaseUrlAnalytics(serverRef),
  })
  const label: Record<typeof transportType, string> = {
    sse: 'SSE',
    http: 'HTTP',
    'zyai-proxy': 'zy.ai proxy',
  }
  logMCPDebug(name, `Authentication required for ${label[transportType]} server`)
  setMcpAuthCacheEntry(name)
  return { name, type: 'needs-auth', config: serverRef }
}

/**
 * Fetch wrapper for zy.ai proxy connections. Attaches the OAuth bearer
 * token and retries once on 401 via handleOAuth401Error (force-refresh).
 *
 * The Anthropic API path has this retry (withRetry.ts, grove.ts) to handle
 * memoize-cache staleness and clock drift. Without the same here, a single
 * stale token mass-401s every zy.ai connector and sticks them all in the
 * 15-min needs-auth cache.
 */
export function createZyAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const currentTokens = getZyAIOAuthTokens()
      if (!currentTokens) {
        throw new Error('No zy.ai OAuth token available')
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // 返回发送时的确切 token。在并发 401 场景下，
      // 请求后再次读取 getZyAIOAuthTokens() 是错误的：另一个
      // 连接器的 handleOAuth401Error 清除了 memoize 缓存，导致我们读到
      // 新的 keychain token，传给 handleOAuth401Error 后，
      // 发现与 keychain 相同 → 返回 false → 跳过重试。与
      // bridgeApi.ts 的 withOAuthRetry 模式相同（token 作为函数参数传递）。
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) {
      return response
    }
    // handleOAuth401Error 仅在 token 实际改变时返回 true
    //（keychain 有更新的，或强制刷新成功）。以此作为重试门控 —
    // 否则每个需要认证的下游连接器都会双倍往返时间
    //（常见情况：30+ 服务器显示"MCP 服务器需要认证但未配置 OAuth token"）。
    const tokenChanged = await handleOAuth401Error(sentToken).catch(() => false)
    logEvent('zy_mcp_Zyai_proxy_401', {
      tokenChanged: tokenChanged as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!tokenChanged) {
      // ELOCKED 竞争：另一个连接器可能已赢得锁文件并完成刷新 — 检查 token 是否在我们底下已改变
      const now = getZyAIOAuthTokens()?.accessToken
      if (!now || now === sentToken) {
        return response
      }
    }
    try {
      return (await doRequest()).response
    } catch {
      // 重试本身失败（网络错误）。返回原始 401，
      // 以便外部处理器进行分类。
      return response
    }
  }
}

// 传递给 mcpWebSocketTransport 的 WebSocket 实例的最小接口
type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
async function createNodeWsClient(
  url: string,
  options: Record<string, unknown>,
): Promise<WsClientLike> {
  const wsModule = await import('ws')
  const WS = wsModule.default as unknown as new (
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) => WsClientLike
  return new WS(url, ['mcp'], options)
}

function getConnectionTimeoutMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 30000
}

/**
 * Default timeout for individual MCP requests (auth, tool calls, etc.)
 */
const MCP_REQUEST_TIMEOUT_MS = 60000

/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

/**
 * 包装 fetch 函数，为每次请求应用新的超时信号。
 * 这避免了在连接时创建单个 AbortSignal.timeout() 在 60 秒后
 * 过期导致后续请求立即失败的 bug。使用 60 秒超时。
 *
 * 同时确保 POST 请求携带 MCP Streamable HTTP 规范要求的 Accept 头。
 * MCP SDK 在 StreamableHTTPClientTransport.send() 中设置此头，
 * 但它附加到一个 Headers 实例上，在此经过对象展开传递，
 * 某些运行时/代理在到达网络前可能丢弃它。
 * 见 https://github.com/anthropics/zy-agent-sdk-typescript/issues/202。
 * 在此规范化（fetch() 前的最后一层包装）保证它被发送。
 *
 * GET 请求排除在超时之外，因为对 MCP 传输来说它们是
 * 无限期保持开放的长连接 SSE 流。（认证相关的 GET 使用
 * auth.ts 中单独的 fetch 包装器，自带超时。）
 *
 * @param baseFetch - 要包装的 fetch 函数
 */
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // GET 请求跳过超时 — 在 MCP 传输中它们是长连接 SSE 流。
    //（auth.ts 中的 OAuth 发现 GET 使用单独的 createAuthFetch()，自带超时。）
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // 规范化请求头并保证 Streamable-HTTP Accept 值。new Headers()
    // 接受 HeadersInit | undefined 并从普通对象、元组数组和
    // 现有 Headers 实例复制 — 因此无论 SDK 传给我们什么形状，
    // Accept 值在下面的展开中作为具体对象的自有属性保留。
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) {
      headers.set('accept', MCP_STREAMABLE_HTTP_ACCEPT)
    }

    // 使用 setTimeout 而非 AbortSignal.timeout()，以便完成后能 clearTimeout。
    // AbortSignal.timeout 的内部定时器仅在信号被 GC 时释放，
    // 而 Bun 是延迟 GC — 即使请求在几毫秒内完成，
    // 每个请求约 2.4KB 原生内存仍会滞留满 60 秒。
    const controller = new AbortController()
    const timer = setTimeout(
      (c) => c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      MCP_REQUEST_TIMEOUT_MS,
      controller,
    )
    timer.unref?.()

    const parentSignal = init?.signal
    const abort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort)
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason)
    }

    const cleanup = () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
    }

    try {
      const response = await baseFetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      cleanup()
      return response
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}

function getRemoteMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 20
}

function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}

// 对于 IDE MCP 服务器，我们只包含特定的工具
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
function isIncludedMcpTool(tool: Tool): boolean {
  return !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
}

/**
 * Generates the cache key for a server connection
 * @param name Server name
 * @param serverRef Server configuration
 * @returns Cache key string
 */
export function getServerCacheKey(name: string, serverRef: ScopedMcpServerConfig): string {
  return `${name}-${jsonStringify(serverRef)}`
}

/**
 * TODO (ollie): The memoization here increases complexity by a lot, and im not sure it really improves performance
 * Attempts to connect to a single MCP server
 * @param name Server name
 * @param serverRef Scoped server configuration
 * @returns A wrapped client (either connected or failed)
 */
export const connectToServer = memoize(
  async (
    name: string,
    serverRef: ScopedMcpServerConfig,
    serverStats?: {
      totalServers: number
      stdioCount: number
      sseCount: number
      httpCount: number
      sseIdeCount: number
      wsIdeCount: number
    },
  ): Promise<MCPServerConnection> => {
    const connectStartTime = Date.now()
    let inProcessServer:
      | { connect(t: Transport): Promise<void>; close(): Promise<void> }
      | undefined
    try {
      let transport

      // 如果有 session ingress JWT，我们将通过 session ingress 连接而非直接连接远程 MCP。
      const sessionIngressToken = getSessionIngressAuthToken()

      if (serverRef.type === 'sse') {
        // 为此服务器创建认证提供者
        const authProvider = new ZyAuthProvider(name, serverRef)

        // 获取组合的请求头（静态 + 动态）
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // 将认证提供者与 SSEClientTransport 配合使用
        const transportOptions: SSEClientTransportOptions = {
          authProvider,
          // 每次请求使用新的超时以避免陈旧的 AbortSignal bug。
          // 升级检测包装在最内层，以便 SDK 的处理器调用
          // auth() → tokens() 之前能看到 403。
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
          ),
          requestInit: {
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...combinedHeaders,
            },
          },
        }

        // 重要：eventSourceInit 必须使用不带超时包装的 fetch。
        // EventSource 连接是长连接（无限期保持开放以接收服务器发送事件），
        // 因此应用 60 秒超时会将其杀死。
        // 超时仅适用于单个 API 请求（POST、认证刷新），不适用于持久 SSE 流。
        transportOptions.eventSourceInit = {
          fetch: async (url: string | URL, init?: RequestInit) => {
            // 从认证提供者获取认证头
            const authHeaders: Record<string, string> = {}
            const tokens = await authProvider.tokens()
            if (tokens) {
              authHeaders.Authorization = `Bearer ${tokens.access_token}`
            }

            const proxyOptions = getProxyFetchOptions()
            // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            return fetch(url, {
              ...init,
              ...proxyOptions,
              headers: {
                'User-Agent': getMCPUserAgent(),
                ...authHeaders,
                ...init?.headers,
                ...combinedHeaders,
                Accept: 'text/event-stream',
              },
            })
          },
        }

        transport = new SSEClientTransport(new URL(serverRef.url), transportOptions)
        logMCPDebug(name, `SSE transport initialized, awaiting connection`)
      } else if (serverRef.type === 'sse-ide') {
        logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
        // IDE 服务器不需要认证
        // TODO: 使用 lockfile 中提供的认证 token
        const proxyOptions = getProxyFetchOptions()
        const transportOptions: SSEClientTransportOptions = proxyOptions.dispatcher
          ? {
              eventSourceInit: {
                fetch: async (url: string | URL, init?: RequestInit) => {
                  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
                  return fetch(url, {
                    ...init,
                    ...proxyOptions,
                    headers: {
                      'User-Agent': getMCPUserAgent(),
                      ...init?.headers,
                    },
                  })
                },
              },
            }
          : {}

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          Object.keys(transportOptions).length > 0 ? transportOptions : undefined,
        )
      } else if (serverRef.type === 'ws-ide') {
        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(serverRef.authToken && {
            'X-Zy-Code-Ide-Authorization': serverRef.authToken,
          }),
        }

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun 的 WebSocket 支持 headers/proxy/tls 选项，但 DOM 类型定义没有包含
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'ws') {
        logMCPDebug(name, `Initializing WebSocket transport to ${serverRef.url}`)

        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(sessionIngressToken && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
          ...combinedHeaders,
        }

        // 记录前对敏感请求头进行脱敏
        const wsHeadersForLogging = mapValues(wsHeaders, (value, key) =>
          key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
        )

        logMCPDebug(
          name,
          `WebSocket transport options: ${jsonStringify({
            url: serverRef.url,
            headers: wsHeadersForLogging,
            hasSessionAuth: !!sessionIngressToken,
          })}`,
        )

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun 的 WebSocket 支持 headers/proxy/tls 选项，但 DOM 类型定义没有包含
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      } else if (serverRef.type === 'http') {
        logMCPDebug(name, `Initializing HTTP transport to ${serverRef.url}`)
        logMCPDebug(name, `Node version: ${process.version}, Platform: ${process.platform}`)
        logMCPDebug(
          name,
          `Environment: ${jsonStringify({
            NODE_OPTIONS: process.env.NODE_OPTIONS || 'not set',
            UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || 'default',
            HTTP_PROXY: process.env.HTTP_PROXY || 'not set',
            HTTPS_PROXY: process.env.HTTPS_PROXY || 'not set',
            NO_PROXY: process.env.NO_PROXY || 'not set',
          })}`,
        )

        // 为此服务器创建认证提供者
        const authProvider = new ZyAuthProvider(name, serverRef)

        // 获取组合的请求头（静态 + 动态）
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // 检查此服务器是否存储了 OAuth token。如果是，SDK 的
        // authProvider 将设置 Authorization — 不要用 session ingress token
        // 覆盖（SDK 在 authProvider 之后合并 requestInit）。
        // CCR 代理 URL（ccr_shttp_mcp）没有存储 OAuth，所以它们
        // 仍然获取 ingress token。见 PR #24454 讨论。
        const hasOAuthTokens = !!(await authProvider.tokens())

        // 将认证提供者与 StreamableHTTPClientTransport 配合使用
        const proxyOptions = getProxyFetchOptions()
        logMCPDebug(
          name,
          `Proxy options: ${proxyOptions.dispatcher ? 'custom dispatcher' : 'default'}`,
        )

        const transportOptions: StreamableHTTPClientTransportOptions = {
          authProvider,
          // 每次请求使用新的超时以避免陈旧的 AbortSignal bug。
          // 升级检测包装在最内层，以便 SDK 的处理器调用
          // auth() → tokens() 之前能看到 403。
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
          ),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...(sessionIngressToken &&
                !hasOAuthTokens && {
                  Authorization: `Bearer ${sessionIngressToken}`,
                }),
              ...combinedHeaders,
            },
          },
        }

        // 记录前对敏感请求头进行脱敏
        const headersForLogging = transportOptions.requestInit?.headers
          ? mapValues(
              transportOptions.requestInit.headers as Record<string, string>,
              (value, key) => (key.toLowerCase() === 'authorization' ? '[REDACTED]' : value),
            )
          : undefined

        logMCPDebug(
          name,
          `HTTP transport options: ${jsonStringify({
            url: serverRef.url,
            headers: headersForLogging,
            hasAuthProvider: !!authProvider,
            timeoutMs: MCP_REQUEST_TIMEOUT_MS,
          })}`,
        )

        transport = new StreamableHTTPClientTransport(new URL(serverRef.url), transportOptions)
        logMCPDebug(name, `HTTP transport created successfully`)
      } else if (serverRef.type === 'sdk') {
        throw new Error('SDK servers should be handled in print.ts')
      } else if (serverRef.type === 'zyai-proxy') {
        logMCPDebug(name, `Initializing zy.ai proxy transport for server ${serverRef.id}`)

        const tokens = getZyAIOAuthTokens()
        if (!tokens) {
          throw new Error('No zy.ai OAuth token found')
        }

        const oauthConfig = getOauthConfig()
        const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`

        logMCPDebug(name, `Using zy.ai proxy at ${proxyUrl}`)

        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        const fetchWithAuth = createZyAiProxyFetch(globalThis.fetch)

        const proxyOptions = getProxyFetchOptions()
        const transportOptions: StreamableHTTPClientTransportOptions = {
          // 用新鲜超时包装 fetchWithAuth
          fetch: wrapFetchWithTimeout(fetchWithAuth),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              'X-Mcp-Client-Session-Id': getSessionId(),
            },
          },
        }

        transport = new StreamableHTTPClientTransport(new URL(proxyUrl), transportOptions)
        logMCPDebug(name, `zy.ai proxy transport created successfully`)
      } else if (
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        ((serverRef as any).type === 'stdio' || !(serverRef as any).type) &&
        isClaudeInChromeMCPServer(name)
      ) {
        // 在进程中运行 Chrome MCP 服务器以避免生成约 325 MB 的子进程
        const { createChromeContext } = await import('../../services/claudeInChrome/mcpServer.js')
        const { createZyForChromeMcpServer } = await import('@ant/claude-for-chrome-mcp')
        const { createLinkedTransportPair } = await import('./InProcessTransport.js')
        const context = createChromeContext(serverRef.env)
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        inProcessServer = createZyForChromeMcpServer(context) as any
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer!.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Chrome MCP server started`)
      } else if (
        feature('CHICAGO_MCP') &&
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        ((serverRef as any).type === 'stdio' || !(serverRef as any).type) &&
        isComputerUseMCPServer!(name)
      ) {
        // 在进程中运行 Computer Use MCP 服务器 — 与上面 Chrome 相同的理由。
        // 该包的 CallTool 处理器是桩；实际分发通过 wrapper.tsx 的
        // .call() 覆盖。
        const { createComputerUseMcpServerForCli } = await import(
          '../../services/computerUse/mcpServer.js'
        )
        const { createLinkedTransportPair } = await import('./InProcessTransport.js')
        inProcessServer = await createComputerUseMcpServerForCli()
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer!.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Computer Use MCP server started`)
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      } else if ((serverRef as any).type === 'stdio' || !(serverRef as any).type) {
        const finalCommand = process.env.ZY_CODE_SHELL_PREFIX || serverRef.command
        const finalArgs = process.env.ZY_CODE_SHELL_PREFIX
          ? [[serverRef.command, ...serverRef.args].join(' ')]
          : serverRef.args
        transport = new StdioClientTransport({
          command: finalCommand,
          args: finalArgs,
          env: {
            ...subprocessEnv(),
            ...serverRef.env,
          } as Record<string, string>,
          stderr: 'pipe', // 防止 MCP 服务器的错误输出打印到 UI
        })
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        throw new Error(`Unsupported server type: ${(serverRef as any).type}`)
      }

      // 在连接前为 stdio 传输设置 stderr 日志记录，以防连接启动期间
      // 有 stderr 输出（这对调试失败的连接很有用）。
      // 存储处理器引用以便清理，防止内存泄漏
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrOutput = ''
      if (serverRef.type === 'stdio' || !serverRef.type) {
        const stdioTransport = transport as StdioClientTransport
        if (stdioTransport.stderr) {
          stderrHandler = (data: Buffer) => {
            // 限制 stderr 累积以防止内存无限增长
            if (stderrOutput.length < 64 * 1024 * 1024) {
              try {
                stderrOutput += data.toString()
              } catch {
                // 忽略超过最大字符串长度的错误
              }
            }
          }
          stdioTransport.stderr.on('data', stderrHandler)
        }
      }

      const client = new Client(
        {
          name: 'zy-code',
          title: 'Zy Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {
            roots: {},
            // 空对象声明该能力。发送 {form:{},url:{}}
            // 会破坏 Java MCP SDK 服务器（Spring AI），其 Elicitation 类
            // 没有字段，遇到未知属性时会失败。
            elicitation: {},
          },
        },
      )

      // Add debug logging for client events if available
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Client created, setting up request handler`)
      }

      client.setRequestHandler(ListRootsRequestSchema, async () => {
        logMCPDebug(name, `Received ListRoots request from server`)
        return {
          roots: [
            {
              uri: `file://${getOriginalCwd()}`,
            },
          ],
        }
      })

      // 为连接尝试添加超时，防止测试无限挂起
      logMCPDebug(name, `Starting connection with timeout of ${getConnectionTimeoutMs()}ms`)

      // 对于 HTTP 传输，先尝试基本连接测试
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Testing basic HTTP connectivity to ${serverRef.url}`)
        try {
          const testUrl = new URL(serverRef.url)
          logMCPDebug(
            name,
            `Parsed URL: host=${testUrl.hostname}, port=${testUrl.port || 'default'}, protocol=${testUrl.protocol}`,
          )

          // 记录 DNS 解析尝试
          if (testUrl.hostname === '127.0.0.1' || testUrl.hostname === 'localhost') {
            logMCPDebug(name, `Using loopback address: ${testUrl.hostname}`)
          }
        } catch (urlError) {
          logMCPDebug(name, `Failed to parse URL: ${urlError}`)
        }
      }

      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
          const elapsed = Date.now() - connectStartTime
          logMCPDebug(
            name,
            `Connection timeout triggered after ${elapsed}ms (limit: ${getConnectionTimeoutMs()}ms)`,
          )
          if (inProcessServer) {
            inProcessServer.close().catch(() => {})
          }
          transport.close().catch(() => {})
          reject(
            new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" connection timed out after ${getConnectionTimeoutMs()}ms`,
              'MCP connection timeout',
            ),
          )
        }, getConnectionTimeoutMs())

        // Clean up timeout if connect resolves or rejects
        connectPromise.then(
          () => {
            clearTimeout(timeoutId)
          },
          (_error) => {
            clearTimeout(timeoutId)
          },
        )
      })

      try {
        await Promise.race([connectPromise, timeoutPromise])
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
          stderrOutput = '' // Release accumulated string to prevent memory growth
        }
        const elapsed = Date.now() - connectStartTime
        logMCPDebug(
          name,
          `Successfully connected (transport: ${serverRef.type || 'stdio'}) in ${elapsed}ms`,
        )
      } catch (error) {
        const elapsed = Date.now() - connectStartTime
        // SSE-specific error logging
        if (serverRef.type === 'sse' && error instanceof Error) {
          logMCPDebug(
            name,
            `SSE Connection failed after ${elapsed}ms: ${jsonStringify({
              url: serverRef.url,
              error: error.message,
              errorType: error.constructor.name,
              stack: error.stack,
            })}`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'sse')
          }
        } else if (serverRef.type === 'http' && error instanceof Error) {
          const errorObj = error as Error & {
            cause?: unknown
            code?: string
            errno?: string | number
            syscall?: string
          }
          logMCPDebug(
            name,
            `HTTP Connection failed after ${elapsed}ms: ${error.message} (code: ${errorObj.code || 'none'}, errno: ${errorObj.errno || 'none'})`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'http')
          }
        } else if (serverRef.type === 'zyai-proxy' && error instanceof Error) {
          logMCPDebug(name, `zy.ai proxy connection failed after ${elapsed}ms: ${error.message}`)
          logMCPError(name, error)

          // StreamableHTTPError has a `code` property with the HTTP status
          const errorCode = (error as Error & { code?: number }).code
          if (errorCode === 401) {
            return handleRemoteAuthFailure(name, serverRef, 'zyai-proxy')
          }
        } else if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
          logEvent('zy_mcp_ide_server_connection_failed', {
            connectionDurationMs: elapsed,
          })
        }
        if (inProcessServer) {
          inProcessServer.close().catch(() => {})
        }
        transport.close().catch(() => {})
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
        }
        throw error
      }

      const capabilities = client.getServerCapabilities()
      const serverVersion = client.getServerVersion()
      const rawInstructions = client.getInstructions()
      let instructions = rawInstructions
      if (rawInstructions && rawInstructions.length > MAX_MCP_DESCRIPTION_LENGTH) {
        instructions = `${rawInstructions.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [truncated]`
        logMCPDebug(
          name,
          `Server instructions truncated from ${rawInstructions.length} to ${MAX_MCP_DESCRIPTION_LENGTH} chars`,
        )
      }

      // Log successful connection details
      logMCPDebug(
        name,
        `Connection established with capabilities: ${jsonStringify({
          hasTools: !!capabilities?.tools,
          hasPrompts: !!capabilities?.prompts,
          hasResources: !!capabilities?.resources,
          hasResourceSubscribe: !!capabilities?.resources?.subscribe,
          serverVersion: serverVersion || 'unknown',
        })}`,
      )
      mcpLog(
        `[MCP] Server "${name}" connected with subscribe=${!!capabilities?.resources?.subscribe}`,
      )

      // Register default elicitation handler that returns cancel during the
      // window before registerElicitationHandler overwrites it in
      // onConnectionAttempt (useManageMCPConnections).
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        logMCPDebug(
          name,
          `Elicitation request received during initialization: ${jsonStringify(request)}`,
        )
        return { action: 'cancel' as const }
      })

      if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
        const ideConnectionDurationMs = Date.now() - connectStartTime
        logEvent('zy_mcp_ide_server_connection_succeeded', {
          connectionDurationMs: ideConnectionDurationMs,
          serverVersion:
            serverVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        try {
          void maybeNotifyIDEConnected(client)
        } catch (error) {
          logMCPError(name, `Failed to send ide_connected notification: ${error}`)
        }
      }

      // Enhanced connection drop detection and logging for all transport types
      const connectionStartTime = Date.now()
      let hasErrorOccurred = false

      // Store original handlers
      const originalOnerror = client.onerror
      const originalOnclose = client.onclose

      // The SDK's transport calls onerror on connection failures but doesn't call onclose,
      // which CC uses to trigger reconnection. We bridge this gap by tracking consecutive
      // terminal errors and manually closing after MAX_ERRORS_BEFORE_RECONNECT failures.
      let consecutiveConnectionErrors = 0
      const MAX_ERRORS_BEFORE_RECONNECT = 3

      // Guard against re-entry: close() aborts in-flight streams which may fire
      // onerror again before the close chain completes.
      let hasTriggeredClose = false

      // client.close() → transport.close() → transport.onclose → SDK's _onclose():
      // rejects all pending request handlers (so hung callTool() promises fail with
      // McpError -32000 "Connection closed") and then invokes our client.onclose
      // handler below (which clears the memo cache so the next call reconnects).
      // Calling client.onclose?.() directly would only clear the cache — pending
      // tool calls would stay hung.
      const closeTransportAndRejectPending = (reason: string) => {
        if (hasTriggeredClose) {
          return
        }
        hasTriggeredClose = true
        logMCPDebug(name, `Closing transport (${reason})`)
        void client.close().catch((e) => {
          logMCPDebug(name, `Error during close: ${errorMessage(e)}`)
        })
      }

      const isTerminalConnectionError = (msg: string): boolean => {
        return (
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EPIPE') ||
          msg.includes('EHOSTUNREACH') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('Body Timeout Error') ||
          msg.includes('terminated') ||
          // SDK SSE reconnection intermediate errors — may be wrapped around the
          // actual network error, so the substrings above won't match
          msg.includes('SSE stream disconnected') ||
          msg.includes('Failed to reconnect SSE stream')
        )
      }

      // Enhanced error handler with detailed logging
      client.onerror = (error: Error) => {
        const uptime = Date.now() - connectionStartTime
        hasErrorOccurred = true
        const transportType = serverRef.type || 'stdio'

        // Log the connection drop with context
        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
        )

        // Log specific error details for debugging
        if (error.message) {
          if (error.message.includes('ECONNRESET')) {
            logMCPDebug(name, `Connection reset - server may have crashed or restarted`)
          } else if (error.message.includes('ETIMEDOUT')) {
            logMCPDebug(name, `Connection timeout - network issue or server unresponsive`)
          } else if (error.message.includes('ECONNREFUSED')) {
            logMCPDebug(name, `Connection refused - server may be down`)
          } else if (error.message.includes('EPIPE')) {
            logMCPDebug(name, `Broken pipe - server closed connection unexpectedly`)
          } else if (error.message.includes('EHOSTUNREACH')) {
            logMCPDebug(name, `Host unreachable - network connectivity issue`)
          } else if (error.message.includes('ESRCH')) {
            logMCPDebug(name, `Process not found - stdio server process terminated`)
          } else if (error.message.includes('spawn')) {
            logMCPDebug(name, `Failed to spawn process - check command and permissions`)
          } else {
            logMCPDebug(name, `Connection error: ${error.message}`)
          }
        }

        // For HTTP transports, detect session expiry (404 + JSON-RPC -32001)
        // and close the transport so pending tool calls reject and the next
        // call reconnects with a fresh session ID.
        if (
          (transportType === 'http' || transportType === 'zyai-proxy') &&
          isMcpSessionExpiredError(error)
        ) {
          logMCPDebug(
            name,
            `MCP session expired (server returned 404 with session-not-found), triggering reconnection`,
          )
          closeTransportAndRejectPending('session expired')
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // For remote transports (SSE/HTTP), track terminal connection errors
        // and trigger reconnection via close if we see repeated failures.
        if (transportType === 'sse' || transportType === 'http' || transportType === 'zyai-proxy') {
          // The SDK's StreamableHTTP transport fires this after exhausting its
          // own SSE reconnect attempts (default maxRetries: 2) — but it never
          // calls onclose, so pending callTool() promises hang indefinitely.
          // This is the definitive "transport gave up" signal.
          if (error.message.includes('Maximum reconnection attempts')) {
            closeTransportAndRejectPending('SSE reconnection exhausted')
            if (originalOnerror) {
              originalOnerror(error)
            }
            return
          }

          if (isTerminalConnectionError(error.message)) {
            consecutiveConnectionErrors++
            logMCPDebug(
              name,
              `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
            )

            if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
              consecutiveConnectionErrors = 0
              closeTransportAndRejectPending('max consecutive terminal errors')
            }
          } else {
            // Non-terminal error (e.g., transient issue), reset counter
            consecutiveConnectionErrors = 0
          }
        }

        // Call original handler
        if (originalOnerror) {
          originalOnerror(error)
        }
      }

      // Enhanced close handler with connection drop context
      client.onclose = () => {
        const uptime = Date.now() - connectionStartTime
        const transportType = serverRef.type ?? 'unknown'

        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
        )

        // Clear the memoization cache so next operation reconnects
        const key = getServerCacheKey(name, serverRef)

        // Also clear fetch caches (keyed by server name). Reconnection
        // creates a new connection object; without clearing, the next
        // fetch would return stale tools/resources from the old connection.
        fetchToolsForClient.cache.delete(name)
        fetchResourcesForClient.cache.delete(name)
        fetchCommandsForClient.cache.delete(name)
        if (feature('MCP_SKILLS')) {
          fetchMcpSkillsForClient!.cache.delete(name)
        }

        connectToServer.cache.delete(key)
        logMCPDebug(name, `Cleared connection cache for reconnection`)

        if (originalOnclose) {
          originalOnclose()
        }
      }

      const cleanup = async () => {
        // In-process servers (e.g. Chrome MCP) don't have child processes or stderr
        if (inProcessServer) {
          try {
            await inProcessServer.close()
          } catch (error) {
            logMCPDebug(name, `Error closing in-process server: ${error}`)
          }
          try {
            await client.close()
          } catch (error) {
            logMCPDebug(name, `Error closing client: ${error}`)
          }
          return
        }

        // Remove stderr event listener to prevent memory leaks
        if (stderrHandler && (serverRef.type === 'stdio' || !serverRef.type)) {
          const stdioTransport = transport as StdioClientTransport
          stdioTransport.stderr?.off('data', stderrHandler)
        }

        // For stdio transports, explicitly terminate the child process with proper signals
        // NOTE: StdioClientTransport.close() only sends an abort signal, but many MCP servers
        // (especially Docker containers) need explicit SIGINT/SIGTERM signals to trigger graceful shutdown
        if (serverRef.type === 'stdio') {
          try {
            const stdioTransport = transport as StdioClientTransport
            const childPid = stdioTransport.pid

            if (childPid) {
              logMCPDebug(name, 'Sending SIGINT to MCP server process')

              // First try SIGINT (like Ctrl+C)
              try {
                process.kill(childPid, 'SIGINT')
              } catch (error) {
                logMCPDebug(name, `Error sending SIGINT: ${error}`)
                return
              }

              // Wait for graceful shutdown with rapid escalation (total 500ms to keep CLI responsive)
              const processExited = () => {
                try {
                  process.kill(childPid, 0)
                  return false
                } catch {
                  return true
                }
              }

              const waitForExit = new Promise<void>((resolve) => {
                const checkInterval = setInterval(() => {
                  if (processExited()) {
                    clearInterval(checkInterval)
                    logMCPDebug(name, 'MCP server process exited cleanly')
                    resolve()
                  }
                }, 50)
              })

              const escalateSignals = async () => {
                await sleep(100)
                if (processExited()) {
                  return
                }
                logMCPDebug(name, 'SIGINT failed, sending SIGTERM to MCP server process')
                try {
                  process.kill(childPid, 'SIGTERM')
                } catch (termError) {
                  logMCPDebug(name, `Error sending SIGTERM: ${termError}`)
                  return
                }

                await sleep(400)
                if (processExited()) {
                  return
                }
                logMCPDebug(name, 'SIGTERM failed, sending SIGKILL to MCP server process')
                try {
                  process.kill(childPid, 'SIGKILL')
                } catch (killError) {
                  logMCPDebug(name, `Error sending SIGKILL: ${killError}`)
                }
              }

              const failsafe = sleep(600).then(() => {
                logMCPDebug(name, 'Cleanup timeout reached, stopping process monitoring')
              })

              void escalateSignals()
              await Promise.race([waitForExit, failsafe])
            }
          } catch (processError) {
            logMCPDebug(name, `Error terminating process: ${processError}`)
          }
        }

        // Close the client connection (which also closes the transport)
        try {
          await client.close()
        } catch (error) {
          logMCPDebug(name, `Error closing client: ${error}`)
        }
      }

      // Register cleanup for all transport types - even network transports might need cleanup
      // This ensures all MCP servers get properly terminated, not just stdio ones
      const cleanupUnregister = registerCleanup(cleanup)

      // Create the wrapped cleanup that includes unregistering
      const wrappedCleanup = async () => {
        cleanupUnregister?.()
        await cleanup()
      }

      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('zy_mcp_server_connection_succeeded', {
        connectionDurationMs,
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        totalServers: serverStats?.totalServers,
        stdioCount: serverStats?.stdioCount,
        sseCount: serverStats?.sseCount,
        httpCount: serverStats?.httpCount,
        sseIdeCount: serverStats?.sseIdeCount,
        wsIdeCount: serverStats?.wsIdeCount,
        ...mcpBaseUrlAnalytics(serverRef),
      })
      return {
        name,
        client,
        type: 'connected' as const,
        capabilities: capabilities ?? {},
        serverInfo: serverVersion,
        instructions,
        config: serverRef,
        cleanup: wrappedCleanup,
      }
    } catch (error) {
      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('zy_mcp_server_connection_failed', {
        connectionDurationMs,
        totalServers: serverStats?.totalServers || 1,
        stdioCount: serverStats?.stdioCount || (serverRef.type === 'stdio' ? 1 : 0),
        sseCount: serverStats?.sseCount || (serverRef.type === 'sse' ? 1 : 0),
        httpCount: serverStats?.httpCount || (serverRef.type === 'http' ? 1 : 0),
        sseIdeCount: serverStats?.sseIdeCount || (serverRef.type === 'sse-ide' ? 1 : 0),
        wsIdeCount: serverStats?.wsIdeCount || (serverRef.type === 'ws-ide' ? 1 : 0),
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...mcpBaseUrlAnalytics(serverRef),
      })
      logMCPDebug(name, `Connection failed after ${connectionDurationMs}ms: ${errorMessage(error)}`)
      logMCPError(name, `Connection failed: ${errorMessage(error)}`)

      if (inProcessServer) {
        inProcessServer.close().catch(() => {})
      }
      return {
        name,
        type: 'failed' as const,
        config: serverRef,
        error: errorMessage(error),
      }
    }
  },
  getServerCacheKey,
)

/**
 * Clears the memoize cache for a specific server
 * @param name Server name
 * @param serverRef Server configuration
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<void> {
  const key = getServerCacheKey(name, serverRef)

  try {
    const wrappedClient = await connectToServer(name, serverRef)

    if (wrappedClient.type === 'connected') {
      await wrappedClient.cleanup()
    }
  } catch {
    // Ignore errors - server might have failed to connect
  }

  // Clear from cache (both connection and fetch caches so reconnect
  // fetches fresh tools/resources/commands instead of stale ones)
  connectToServer.cache.delete(key)
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  if (feature('MCP_SKILLS')) {
    fetchMcpSkillsForClient!.cache.delete(name)
  }
}

/**
 * Ensures a valid connected client for an MCP server.
 * For most server types, uses the memoization cache if available, or reconnects
 * if the cache was cleared (e.g., after onclose). This ensures tool/resource
 * calls always use a valid connection.
 *
 * SDK MCP servers run in-process and are handled separately via setupSdkMcpClients,
 * so they are returned as-is without going through connectToServer.
 *
 * @param client The connected MCP server client
 * @returns Connected MCP server client (same or reconnected)
 * @throws Error if server cannot be connected
 */
export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  // SDK MCP servers run in-process and are handled separately via setupSdkMcpClients
  if (client.config.type === 'sdk') {
    return client
  }

  const connectedClient = await connectToServer(client.name, client.config)
  if (connectedClient.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connectedClient
}

/**
 * Compares two MCP server configurations to determine if they are equivalent.
 * Used to detect when a server needs to be reconnected due to config changes.
 */
export function areMcpConfigsEqual(a: ScopedMcpServerConfig, b: ScopedMcpServerConfig): boolean {
  // Quick type check first
  if (a.type !== b.type) {
    return false
  }

  // Compare by serializing - this handles all config variations
  // We exclude 'scope' from comparison since it's metadata, not connection config
  const { scope: _scopeA, ...configA } = a
  const { scope: _scopeB, ...configB } = b
  return jsonStringify(configA) === jsonStringify(configB)
}

// Max cache size for fetch* caches. Keyed by server name (stable across
// reconnects), bounded to prevent unbounded growth with many MCP servers.
const MCP_FETCH_CACHE_SIZE = 20

/**
 * Encode MCP tool input for the auto-mode security classifier.
 * Exported so the auto-mode eval scripts can mirror production encoding
 * for `mcp__*` tool stubs without duplicating this logic.
 */
export function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const keys = Object.keys(input)
  return keys.length > 0 ? keys.map((k) => `${k}=${String(input[k])}`).join(' ') : toolName
}

export let fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') {
      return []
    }

    try {
      if (!client.capabilities?.tools) {
        return []
      }

      const result = (await client.client.request(
        { method: 'tools/list' },
        ListToolsResultSchema,
      )) as ListToolsResult

      // Sanitize tool data from MCP server
      const toolsToProcess = recursivelySanitizeUnicode(result.tools)

      // Check if we should skip the mcp__ prefix for SDK MCP servers
      const skipPrefix =
        client.config.type === 'sdk' && isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)

      // Convert MCP tools to our Tool format
      return toolsToProcess
        .map((tool): Tool => {
          const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
          return {
            ...MCPTool,
            // In skip-prefix mode, use the original name for model invocation so MCP tools
            // can override builtins by name. mcpInfo is used for permission checking.
            name: skipPrefix ? tool.name : fullyQualifiedName,
            mcpInfo: { serverName: client.name, toolName: tool.name },
            isMcp: true,
            // Collapse whitespace: _meta is open to external MCP servers, and
            // a newline here would inject orphan lines into the deferred-tool
            // list (formatDeferredToolLine joins on '\n').
            searchHint:
              typeof tool._meta?.['anthropic/searchHint'] === 'string'
                ? tool._meta['anthropic/searchHint'].replace(/\s+/g, ' ').trim() || undefined
                : undefined,
            alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
            async description() {
              return tool.description ?? ''
            },
            async prompt() {
              const desc = tool.description ?? ''
              return desc.length > MAX_MCP_DESCRIPTION_LENGTH
                ? `${desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [truncated]`
                : desc
            },
            isConcurrencySafe() {
              return tool.annotations?.readOnlyHint ?? false
            },
            isReadOnly() {
              return tool.annotations?.readOnlyHint ?? false
            },
            toAutoClassifierInput(input) {
              return mcpToolInputToAutoClassifierInput(input, tool.name)
            },
            isDestructive() {
              return tool.annotations?.destructiveHint ?? false
            },
            isOpenWorld() {
              return tool.annotations?.openWorldHint ?? false
            },
            isSearchOrReadCommand() {
              return classifyMcpToolForCollapse(client.name, tool.name)
            },
            inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
            async checkPermissions() {
              return {
                behavior: 'passthrough' as const,
                message: 'MCPTool requires permission.',
                suggestions: [
                  {
                    type: 'addRules' as const,
                    rules: [
                      {
                        toolName: fullyQualifiedName,
                        ruleContent: undefined,
                      },
                    ],
                    behavior: 'allow' as const,
                    destination: 'localSettings' as const,
                  },
                ],
              }
            },
            async call(
              args: Record<string, unknown>,
              context,
              _canUseTool,
              parentMessage,
              onProgress?: ToolCallProgress<MCPProgress>,
            ) {
              const toolUseId = parentMessage ? extractToolUseId(parentMessage) : undefined
              const meta = toolUseId ? { 'zycode/toolUseId': toolUseId } : {}

              // Emit progress when tool starts
              if (onProgress && toolUseId) {
                onProgress({
                  toolUseID: toolUseId,
                  data: {
                    type: 'mcp_progress',
                    status: 'started',
                    serverName: client.name,
                    toolName: tool.name,
                  },
                })
              }

              const startTime = Date.now()
              const MAX_SESSION_RETRIES = 1
              for (let attempt = 0; ; attempt++) {
                try {
                  const connectedClient = await ensureConnectedClient(client)
                  const mcpResult = await callMCPToolWithUrlElicitationRetry({
                    client: connectedClient,
                    clientConnection: client,
                    tool: tool.name,
                    args,
                    meta,
                    signal: context.abortController.signal,
                    setAppState: context.setAppState,
                    onProgress:
                      onProgress && toolUseId
                        ? (progressData) => {
                            onProgress({
                              toolUseID: toolUseId,
                              data: progressData,
                            })
                          }
                        : undefined,
                    handleElicitation: context.handleElicitation,
                  })

                  // Emit progress when tool completes successfully
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'completed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }

                  return {
                    data: mcpResult.content,
                    ...((mcpResult._meta || mcpResult.structuredContent) && {
                      mcpMeta: {
                        ...(mcpResult._meta && {
                          _meta: mcpResult._meta,
                        }),
                        ...(mcpResult.structuredContent && {
                          structuredContent: mcpResult.structuredContent,
                        }),
                      },
                    }),
                  }
                } catch (error) {
                  // Session expired — the connection cache has been
                  // cleared, so retry with a fresh client.
                  if (error instanceof McpSessionExpiredError && attempt < MAX_SESSION_RETRIES) {
                    logMCPDebug(client.name, `Retrying tool '${tool.name}' after session recovery`)
                    continue
                  }

                  // Emit progress when tool fails
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'failed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }
                  // Wrap MCP SDK errors so telemetry gets useful context
                  // instead of just "Error" or "McpError" (the constructor
                  // name). MCP SDK errors are protocol-level messages and
                  // don't contain user file paths or code.
                  if (
                    error instanceof Error &&
                    !(error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                  ) {
                    const name = error.constructor.name
                    if (name === 'Error') {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        error.message.slice(0, 200),
                      )
                    }
                    // McpError has a numeric `code` with the JSON-RPC error
                    // code (e.g. -32000 ConnectionClosed, -32001 RequestTimeout)
                    if (name === 'McpError' && 'code' in error && typeof error.code === 'number') {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        `McpError ${error.code}`,
                      )
                    }
                  }
                  throw error
                }
              }
            },
            userFacingName() {
              // Prefer title annotation if available, otherwise use tool name
              const displayName = tool.annotations?.title || tool.name
              return `${client.name} - ${displayName} (MCP)`
            },
            ...(isClaudeInChromeMCPServer(client.name) &&
            (client.config.type === 'stdio' || !client.config.type)
              ? ClaudeInChromeToolRendering().getClaudeInChromeMCPToolOverrides(tool.name)
              : {}),
            ...(feature('CHICAGO_MCP') &&
            (client.config.type === 'stdio' || !client.config.type) &&
            isComputerUseMCPServer!(client.name)
              ? computerUseWrapper!().getComputerUseMCPToolOverrides(tool.name)
              : {}),
          }
        })
        .filter(isIncludedMcpTool)
    } catch (error) {
      logMCPError(client.name, `Failed to fetch tools: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

export let fetchResourcesForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<ServerResource[]> => {
    if (client.type !== 'connected') {
      return []
    }

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      const result = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )

      if (!result.resources) {
        return []
      }

      // Add server name to each resource
      return result.resources.map((resource) => ({
        ...resource,
        server: client.name,
      }))
    } catch (error) {
      logMCPError(client.name, `Failed to fetch resources: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

export let fetchCommandsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') {
      return []
    }

    try {
      if (!client.capabilities?.prompts) {
        return []
      }

      // Request prompts list from client
      const result = (await client.client.request(
        { method: 'prompts/list' },
        ListPromptsResultSchema,
      )) as ListPromptsResult

      if (!result.prompts) {
        return []
      }

      // Sanitize prompt data from MCP server
      const promptsToProcess = recursivelySanitizeUnicode(result.prompts)

      // Convert MCP prompts to our Command format
      return promptsToProcess.map((prompt) => {
        const argNames = Object.values(prompt.arguments ?? {}).map((k) => k.name)
        return {
          type: 'prompt' as const,
          name: `mcp__${normalizeNameForMCP(client.name)}__${prompt.name}`,
          description: prompt.description ?? '',
          hasUserSpecifiedDescription: !!prompt.description,
          contentLength: 0, // Dynamic MCP content
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          progressMessage: 'running',
          userFacingName() {
            // 使用 prompt.name（程序标识符）而非 prompt.title（显示名称）
            // 以避免空格破坏斜杠命令解析
            return `${client.name}:${prompt.name} (MCP)`
          },
          argNames,
          source: 'mcp',
          async getPromptForCommand(args: string) {
            const argsArray = args.split(' ')
            try {
              const connectedClient = await ensureConnectedClient(client)
              const result = await connectedClient.client.getPrompt({
                name: prompt.name,
                arguments: zipObject(argNames, argsArray),
              })
              const transformed = await Promise.all(
                result.messages.map((message) =>
                  transformResultContent(message.content, connectedClient.name),
                ),
              )
              return transformed.flat()
            } catch (error) {
              logMCPError(
                client.name,
                `Error running command '${prompt.name}': ${errorMessage(error)}`,
              )
              throw error
            }
          },
        }
      })
    } catch (error) {
      logMCPError(client.name, `Failed to fetch commands: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

/**
 * Note: This should not be called by UI components directly, they should use the reconnectMcpServer
 * function from useManageMcpConnections.
 * @param name Server name
 * @param config Server configuration
 * @returns Object containing the client connection and its resources
 */
export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}> {
  try {
    // 清除 keychain 缓存，以便从磁盘读取最新的凭证。
    // 当另一个进程（如 VS Code 扩展主机）修改了存储的 token
    //（清除认证、保存新的 OAuth token）然后请求 CLI 子进程
    // 重新连接时，这是必要的。否则子进程会使用陈旧的缓存数据，
    // 永远不会注意到 token 已被移除。
    clearKeychainCache()

    await clearServerCache(name, config)
    const client = await connectToServer(name, config)

    if (client.type !== 'connected') {
      return {
        client,
        tools: [],
        commands: [],
      }
    }

    if (config.type === 'zyai-proxy') {
      markZyAiMcpConnected(name)
    }

    const supportsResources = !!client.capabilities?.resources

    const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      feature('MCP_SKILLS') && supportsResources
        ? fetchMcpSkillsForClient!(client)
        : Promise.resolve([]),
      supportsResources ? fetchResourcesForClient(client) : Promise.resolve([]),
    ])
    const commands: Command[] = [...mcpCommands, ...mcpSkills] as Command[]

    // 检查是否需要添加资源工具
    const resourceTools: Tool[] = []
    if (supportsResources) {
      // 仅当没有其他服务器有资源工具时才添加
      const hasResourceTools = [ListMcpResourcesTool, ReadMcpResourceTool].some((tool) =>
        tools.some((t: Tool) => toolMatchesName(t, tool.name)),
      )
      if (!hasResourceTools) {
        resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool)
      }
    }

    return {
      client,
      tools: [...tools, ...resourceTools],
      commands,
      resources: resources.length > 0 ? resources : undefined,
    }
  } catch (error) {
    // 优雅处理错误 — 连接可能在获取期间已关闭
    logMCPError(name, `Error during reconnection: ${errorMessage(error)}`)

    // 返回失败状态
    return {
      client: { name, type: 'failed' as const, config },
      tools: [],
      commands: [],
    }
  }
}

// 2026-03 替换：之前的实现运行固定大小的顺序批次
//（等待批次 1 完全完成，然后启动批次 2）。这意味着批次 N 中
// 一个慢速服务器会拖住批次 N+1 的所有服务器，即使其他 19 个槽位空闲。
// pMap 在服务器完成后立即释放每个槽位，因此单个慢速服务器
// 只占用一个槽位而非阻塞整个批次边界。相同的并发上限，相同的结果，更好的调度。
async function processBatched<T>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  await pMap(items, processor, { concurrency })
}

export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt: (params: {
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }) => void,
  mcpConfigs?: Record<string, ScopedMcpServerConfig>,
): Promise<void> {
  let resourceToolsAdded = false

  const allConfigEntries = Object.entries(mcpConfigs ?? (await getAllMcpConfigs()).servers)

  // 分区为禁用和活跃条目 — 禁用的服务器不应
  // 生成 HTTP 连接或流经批次处理
  const configEntries: typeof allConfigEntries = []
  for (const entry of allConfigEntries) {
    if (isMcpServerDisabled(entry[0])) {
      onConnectionAttempt({
        client: { name: entry[0], type: 'disabled', config: entry[1] },
        tools: [],
        commands: [],
      })
    } else {
      configEntries.push(entry)
    }
  }

  // 计算传输类型数量用于日志
  const totalServers = configEntries.length
  const stdioCount = count(configEntries, ([_, c]) => c.type === 'stdio')
  const sseCount = count(configEntries, ([_, c]) => c.type === 'sse')
  const httpCount = count(configEntries, ([_, c]) => c.type === 'http')
  const sseIdeCount = count(configEntries, ([_, c]) => c.type === 'sse-ide')
  const wsIdeCount = count(configEntries, ([_, c]) => c.type === 'ws-ide')

  // 按类型拆分服务器：本地（stdio/sdk）需要较低并发，因为
  // 涉及进程生成，远程服务器可以较高并发连接
  const localServers = configEntries.filter(([_, config]) => isLocalMcpServer(config))
  const remoteServers = configEntries.filter(([_, config]) => !isLocalMcpServer(config))

  const serverStats = {
    totalServers,
    stdioCount,
    sseCount,
    httpCount,
    sseIdeCount,
    wsIdeCount,
  }

  const processServer = async ([name, config]: [string, ScopedMcpServerConfig]): Promise<void> => {
    try {
      // 检查服务器是否已禁用 — 如果是，仅添加到状态而不连接
      if (isMcpServerDisabled(name)) {
        onConnectionAttempt({
          client: {
            name,
            type: 'disabled',
            config,
          },
          tools: [],
          commands: [],
        })
        return
      }

      // 跳过最近返回 401 的服务器（15 分钟 TTL），
      // 或之前探测过但没有 token 的服务器。第二个检查
      // 关闭了 TTL 留下的缺口：没有它，每 15 分钟
      // 我们会重新探测无法成功的服务器，直到用户运行 /mcp。
      // 每次探测都是一次 connect-401 加 OAuth 发现的网络往返，
      // 而 print 模式会等待整个批次（main.tsx:3503）。
      if (
        (config.type === 'zyai-proxy' || config.type === 'http' || config.type === 'sse') &&
        ((await isMcpAuthCached(name)) ||
          ((config.type === 'http' || config.type === 'sse') &&
            hasMcpDiscoveryButNoToken(name, config)))
      ) {
        logMCPDebug(name, `Skipping connection (cached needs-auth)`)
        onConnectionAttempt({
          client: { name, type: 'needs-auth' as const, config },
          tools: [createMcpAuthTool(name, config)],
          commands: [],
        })
        return
      }

      const client = await connectToServer(name, config, serverStats)

      if (client.type !== 'connected') {
        onConnectionAttempt({
          client,
          tools: client.type === 'needs-auth' ? [createMcpAuthTool(name, config)] : [],
          commands: [],
        })
        return
      }

      if (config.type === 'zyai-proxy') {
        markZyAiMcpConnected(name)
      }

      const supportsResources = !!client.capabilities?.resources

      const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
        fetchToolsForClient(client),
        fetchCommandsForClient(client),
        // 从 skill:// 资源发现技能
        feature('MCP_SKILLS') && supportsResources
          ? fetchMcpSkillsForClient!(client)
          : Promise.resolve([]),
        // 如果支持则获取资源
        supportsResources ? fetchResourcesForClient(client) : Promise.resolve([]),
      ])
      const commands: Command[] = [...mcpCommands, ...mcpSkills] as Command[]

      // 如果此服务器支持资源且我们尚未添加资源工具，
      // 将此客户端的工具包含资源工具
      const resourceTools: Tool[] = []
      if (supportsResources && !resourceToolsAdded) {
        resourceToolsAdded = true
        resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool)
      }

      onConnectionAttempt({
        client,
        tools: [...tools, ...resourceTools],
        commands,
        resources: resources.length > 0 ? resources : undefined,
      })
    } catch (error) {
      // 优雅处理错误 — 连接可能在获取期间已关闭
      logMCPError(name, `Error fetching tools/commands/resources: ${errorMessage(error)}`)

      // 仍然用客户端更新，但不含工具/命令
      onConnectionAttempt({
        client: { name, type: 'failed' as const, config },
        tools: [],
        commands: [],
      })
    }
  }

  // 并发处理两个组，各自使用独立的并发限制：
  // - 本地服务器（stdio/sdk）：较低并发以避免进程生成的资源竞争
  // - 远程服务器：较高并发，因为它们只是网络连接
  await Promise.all([
    processBatched(localServers, getMcpServerConnectionBatchSize(), processServer),
    processBatched(remoteServers, getRemoteMcpServerConnectionBatchSize(), processServer),
  ])
}

// 不使用备忘录：仅在启动/重新配置时调用 2-3 次。内部工作
//（connectToServer、fetch*ForClient）已缓存。在此按
// mcpConfigs 对象引用备忘录会泄漏 — main.tsx 每次调用都创建新的配置对象。
export function prefetchAllMcpResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
}> {
  return new Promise((resolve) => {
    let pendingCount = 0
    let completedCount = 0

    pendingCount = Object.keys(mcpConfigs).length

    if (pendingCount === 0) {
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
      return
    }

    const clients: MCPServerConnection[] = []
    const tools: Tool[] = []
    const commands: Command[] = []

    getMcpToolsCommandsAndResources((result) => {
      clients.push(result.client)
      tools.push(...result.tools)
      commands.push(...result.commands)

      completedCount++
      if (completedCount >= pendingCount) {
        const commandsMetadataLength = commands.reduce((sum, command) => {
          const commandMetadataLength =
            command.name.length +
            (command.description ?? '').length +
            (command.argumentHint ?? '').length
          return sum + commandMetadataLength
        }, 0)
        logEvent('zy_mcp_tools_commands_loaded', {
          tools_count: tools.length,
          commands_count: commands.length,
          commands_metadata_length: commandsMetadataLength,
        })

        void resolve({
          clients,
          tools,
          commands,
        })
      }
    }, mcpConfigs).catch((error) => {
      logMCPError('prefetchAllMcpResources', `Failed to get MCP resources: ${errorMessage(error)}`)
      // 仍然返回空结果
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
    })
  })
}

/**
 * 通过创建传输和连接来设置 SDK MCP 客户端。
 * 用于与 SDK 同进程运行的 SDK MCP 服务器。
 *
 * @param sdkMcpConfigs - SDK MCP 服务器配置
 * @param sendMcpMessage - 通过控制通道发送 MCP 消息的回调
 * @returns 已连接的客户端、它们的工具以及用于消息路由的传输映射
 */
export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
}> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []

  // 并行连接所有服务器
  const results = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]) => {
      const transport = new WireControlClientTransport(name, sendMcpMessage)

      const client = new Client(
        {
          name: 'zy-code',
          title: 'Zy Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {},
        },
      )

      try {
        // 连接客户端
        await client.connect(transport)

        // 从服务器获取能力
        const capabilities = client.getServerCapabilities()

        // 创建已连接的客户端对象
        const connectedClient: MCPServerConnection = {
          type: 'connected',
          name,
          capabilities: capabilities || {},
          client,
          config: { ...config, scope: 'dynamic' as const },
          cleanup: async () => {
            await client.close()
          },
        }

        // 如果服务器有工具则获取
        const serverTools: Tool[] = []
        if (capabilities?.tools) {
          const sdkTools = await fetchToolsForClient(connectedClient)
          serverTools.push(...sdkTools)
        }

        return {
          client: connectedClient,
          tools: serverTools,
        }
      } catch (error) {
        // 如果连接失败，返回失败的服务器
        logMCPError(name, `Failed to connect SDK MCP server: ${error}`)
        return {
          client: {
            type: 'failed' as const,
            name,
            config: { ...config, scope: 'user' as const },
          },
          tools: [],
        }
      }
    }),
  )

  // 处理结果并收集客户端和工具
  for (const result of results) {
    if (result.status === 'fulfilled') {
      clients.push(result.value.client)
      tools.push(...result.value.tools)
    }
    // 如果被拒绝（意外），错误已在 promise 内部记录
  }

  return { clients, tools }
}
