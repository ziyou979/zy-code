import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { PRODUCT_URL } from '../../../constants/product.js'
import { type Tool } from '../../../tools/tool.js'
import { logMCPError } from '../../../services/infra/log.js'
import { WireControlClientTransport } from '../bridgeControlTransport.js'
import type { MCPServerConnection, McpSdkServerConfig } from '../types.js'
import { fetchToolsForClient } from './connection.js'
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
