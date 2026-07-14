import { feature } from 'bun:bundle'
import { type FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type Tool } from '../../../tool.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getZyAIOAuthTokens,
  handleOAuth401Error,
} from '../../auth/auth.js'
import { createDebugLog } from '../../../utils/debug.js'
import { logMCPDebug } from '../../../utils/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../analytics/index.js'
import { getLoggingSafeMcpBaseUrl } from '../utils.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../types.js'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getZyConfigHomeDir } from '../../../utils/envUtils.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonParse, jsonStringify } from '../../../utils/slowOperations.js'
export const mcpLog = createDebugLog('mcp')

/* eslint-disable @typescript-eslint/no-require-imports */
export const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (require('../../../skills/mcpSkills.js') as typeof import('../../../skills/mcpSkills.js'))
      .fetchMcpSkillsForClient
  : null

/* eslint-disable @typescript-eslint/no-require-imports */
export const isComputerUseMCPServer = feature('CHICAGO_MCP')
  ? (require('../../computer-use/common.js') as typeof import('../../computer-use/common.js'))
      .isComputerUseMCPServer
  : undefined

export const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000
// 15 min

export type McpAuthCacheData = Record<string, { timestamp: number }>

export function getMcpAuthCachePath(): string {
  return join(getZyConfigHomeDir(), 'mcp-needs-auth-cache.json')
}

// 备忘录化，使批量连接期间 N 次并发 isMcpAuthCached() 调用
// 共享单次文件读取而非 N 次读取同一文件。
// 写入时（setMcpAuthCacheEntry）和清除时（clearMcpAuthCache）失效。
// 不使用 lodash memoize 因为我们需要清空整个缓存而非按键删除。
export let authCachePromise: Promise<McpAuthCacheData> | null = null

export function getMcpAuthCache(): Promise<McpAuthCacheData> {
  if (!authCachePromise) {
    authCachePromise = readFile(getMcpAuthCachePath(), 'utf-8')
      .then((data) => jsonParse(data) as McpAuthCacheData)
      .catch(() => ({}))
  }
  return authCachePromise
}

export async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  if (!entry) {
    return false
  }
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS
}

// 通过 promise 链序列化缓存写入，防止同一批次中
// 多个服务器返回 401 时的并发读-改-写竞争
export let writeChain = Promise.resolve()

export function setMcpAuthCacheEntry(serverId: string): void {
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
export function mcpBaseUrlAnalytics(serverRef: ScopedMcpServerConfig): {
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
export function handleRemoteAuthFailure(
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
export type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
export async function createNodeWsClient(
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

export function getConnectionTimeoutMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 30000
}

/**
 * Default timeout for individual MCP requests (auth, tool calls, etc.)
 */
export const MCP_REQUEST_TIMEOUT_MS = 60000

/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
export const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

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

export function getRemoteMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 20
}

export function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}

// 对于 IDE MCP 服务器，我们只包含特定的工具
export const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']

export function isIncludedMcpTool(tool: Tool): boolean {
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
