import { feature } from 'bun:bundle'
import {
  type ListPromptsResult,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  type ListToolsResult,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import zipObject from 'lodash-es/zipObject.js'
import pMap from 'p-map'
import type { Command } from '../../../commands/index.js'
import { type Tool, type ToolCallProgress, toolMatchesName } from '../../../tools/tool.js'
import { ListMcpResourcesTool } from '../../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { type MCPProgress, MCPTool } from '../../../tools/MCPTool/MCPTool.js'
import { createMcpAuthTool } from '../../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { count } from '../../../utils/array.js'
import { isEnvTruthy } from '../../../services/infra/envUtils.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../../utils/errors.js'
import { logMCPDebug, logMCPError } from '../../../services/infra/log.js'
import { memoizeWithLRU } from '../../../utils/memoize.js'
import { recursivelySanitizeUnicode } from '../../../services/permissions/sanitization.js'
import { logEvent } from '../../analytics/index.js'
import { transformResultContent } from '../mcpResults.js'
import { buildMcpTool, mcpToolInputToAutoClassifierInput } from './buildMcpTool.js'
import { normalizeNameForMCP } from '../normalization.js'
import { clearKeychainCache } from '../../secure-storage/macOsKeychainHelpers.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasMcpDiscoveryButNoToken } from '../auth.js'
import { getAllMcpConfigs, isMcpServerDisabled } from '../config.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../types.js'
import { markZyAiMcpConnected } from '../zyai.js'
/**
 * 自定义错误类，表示 MCP 工具调用因认证问题失败
 *（例如 OAuth token 过期返回 401）。
 * 此错误应在工具执行层被捕获，以将客户端状态更新为 'needs-auth'。
 */

/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonStringify } from '../../../services/infra/slowOperations.js'
import {
  fetchMcpSkillsForClient,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
  getServerCacheKey,
  isIncludedMcpTool,
  isLocalMcpServer,
  isMcpAuthCached,
} from './authCache.js'
import { connectToServer } from './transport.js'
export { mcpToolInputToAutoClassifierInput } from './buildMcpTool.js'
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
export const MCP_FETCH_CACHE_SIZE = 20

export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') {
      return []
    }

    try {
      if (!client.capabilities?.tools) {
        return []
      }

      // 支持 tools/list 分页：MCP 协议允许服务器返回 nextCursor 表示有更多结果
      // 必须循环获取所有页，否则部分工具会静默丢失（CC 2.1.146+ 行为对齐）
      const MAX_TOOL_LIST_PAGES = 10
      const allTools: ListToolsResult['tools'] = []
      let pageCursor: string | undefined
      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
        const result = (await client.client.request(
          pageCursor
            ? { method: 'tools/list', params: { cursor: pageCursor } }
            : { method: 'tools/list' },
          ListToolsResultSchema,
        )) as ListToolsResult

        allTools.push(...result.tools)

        pageCursor = result.nextCursor
        if (!pageCursor) {
          break
        }
      }

      if (allTools.length === 0) {
        return []
      }

      // Sanitize tool data from MCP server
      const toolsToProcess = recursivelySanitizeUnicode(allTools)

      // Check if we should skip the mcp__ prefix for SDK MCP servers
      const skipPrefix =
        client.config.type === 'sdk' && isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)

      // Convert MCP tools to our Tool format
      return toolsToProcess
        .map(
          (tool): Tool =>
            buildMcpTool({
              client,
              tool,
              skipPrefix,
              ensureConnectedClient,
            }),
        )
        .filter(isIncludedMcpTool)
    } catch (error) {
      logMCPError(client.name, `Failed to fetch tools: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

export const fetchResourcesForClient = memoizeWithLRU(
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

export const fetchCommandsForClient = memoizeWithLRU(
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
      feature('MCP_SKILLS')
        ? supportsResources
          ? fetchMcpSkillsForClient!(client)
          : Promise.resolve([])
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
export async function processBatched<T>(
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
        feature('MCP_SKILLS')
          ? supportsResources
            ? fetchMcpSkillsForClient!(client)
            : Promise.resolve([])
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
