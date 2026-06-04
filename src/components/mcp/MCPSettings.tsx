import React, { useEffect } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { tSync } from '../../i18n/index.js'
import { ZyAuthProvider } from '../../services/mcp/auth.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  McpZyAIProxyServerConfig,
} from '../../services/mcp/types.js'
import { extractAgentMcpServers, filterToolsByServer } from '../../services/mcp/utils.js'
import { useAppState } from '../../state/AppState.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { MCPAgentServerMenu } from './MCPAgentServerMenu.js'
import { MCPListPanel } from './MCPListPanel.js'
import { MCPRemoteServerMenu } from './MCPRemoteServerMenu.js'
import { MCPStdioServerMenu } from './MCPStdioServerMenu.js'
import { MCPToolDetailView } from './MCPToolDetailView.js'
import { MCPToolListView } from './MCPToolListView.js'

type Props = {
  onComplete: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
export function MCPSettings({ onComplete }: Props) {
  const mcp = useAppState((s) => s.mcp)
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const mcpClients = mcp.clients
  const [viewState, setViewState] = React.useState<{
    type: string
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    server?: any
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    agentServer?: any
    defaultTab?: string
    toolIndex?: number
  }>({
    type: 'list',
  })
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  const [servers, setServers] = React.useState<any[]>([])
  const agentMcpServers = extractAgentMcpServers(agentDefinitions.allAgents)
  const filteredClients = mcpClients
    .filter((client) => client.name !== 'ide')
    .sort((a, b) => a.name.localeCompare(b.name))
  React.useEffect(() => {
    let cancelled = false
    const prepareServers = async function prepareServers() {
      const serverInfos = await Promise.all(
        filteredClients.map(async (client) => {
          const scope = client.config.scope
          const isSSE = client.config.type === 'sse'
          const isHTTP = client.config.type === 'http'
          const isZyAIProxy = client.config.type === 'zyai-proxy'
          let isAuthenticated
          if (isSSE || isHTTP) {
            const authProvider = new ZyAuthProvider(
              client.name,
              client.config as McpSSEServerConfig | McpHTTPServerConfig,
            )
            const tokens = await authProvider.tokens()
            const hasSessionAuth =
              getSessionIngressAuthToken() !== null && client.type === 'connected'
            const hasToolsAndConnected =
              client.type === 'connected' && filterToolsByServer(mcp.tools, client.name).length > 0
            isAuthenticated = Boolean(tokens) || hasSessionAuth || hasToolsAndConnected
          }
          const baseInfo = {
            name: client.name,
            client: client,
            scope,
          }
          if (isZyAIProxy) {
            return {
              ...baseInfo,
              transport: 'zyai-proxy' as const,
              isAuthenticated: false,
              config: client.config as McpZyAIProxyServerConfig,
            }
          } else {
            if (isSSE) {
              return {
                ...baseInfo,
                transport: 'sse' as const,
                isAuthenticated,
                config: client.config as McpSSEServerConfig,
              }
            } else {
              if (isHTTP) {
                return {
                  ...baseInfo,
                  transport: 'http' as const,
                  isAuthenticated,
                  config: client.config as McpHTTPServerConfig,
                }
              } else {
                return {
                  ...baseInfo,
                  transport: 'stdio' as const,
                  config: client.config as McpStdioServerConfig,
                }
              }
            }
          }
        }),
      )
      if (cancelled) {
        return
      }
      setServers(serverInfos)
    }
    prepareServers()
    return () => {
      cancelled = true
    }
  }, [filteredClients, mcp.tools])
  useEffect(() => {
    if (servers.length === 0 && filteredClients.length > 0) {
      return
    }
    if (servers.length === 0 && agentMcpServers.length === 0) {
      onComplete(tSync('mcp.noServersConfigured'))
    }
  }, [servers.length, filteredClients.length, agentMcpServers.length, onComplete])
  switch (viewState.type) {
    case 'list': {
      let handleSelectAgentServer
      let handleSelectServer
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      handleSelectServer = (server: any) =>
        setViewState({
          type: 'server-menu',
          server,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      handleSelectAgentServer = (agentServer: any) =>
        setViewState({
          type: 'agent-server-menu',
          agentServer,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      let listPanel
      listPanel = (
        <MCPListPanel
          servers={servers}
          agentServers={agentMcpServers}
          onSelectServer={handleSelectServer}
          onSelectAgentServer={handleSelectAgentServer}
          onComplete={onComplete}
        />
      )
      return listPanel
    }
    case 'server-menu': {
      let serverToolsFiltered
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      serverToolsFiltered = filterToolsByServer(mcp.tools, (viewState as any).server.name)
      const serverTools = serverToolsFiltered
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      const defaultTab = (viewState as any).server.transport === 'zyai-proxy' ? 'zy.ai' : 'ZY Code'
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      if ((viewState as any).server.transport === 'stdio') {
        let handleViewTools
        handleViewTools = () =>
          setViewState({
            type: 'server-tools',
            // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
            server: (viewState as any).server,
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          } as any)
        let handleCancel
        handleCancel = () =>
          setViewState({
            type: 'list',
            defaultTab,
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          } as any)
        let stdioMenu
        stdioMenu = (
          <MCPStdioServerMenu
            // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
            server={(viewState as any).server}
            serverToolsCount={serverTools.length}
            onViewTools={handleViewTools}
            onCancel={handleCancel}
            onComplete={onComplete}
          />
        )
        return stdioMenu
      } else {
        let handleViewTools
        handleViewTools = () =>
          setViewState({
            type: 'server-tools',
            // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
            server: (viewState as any).server,
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          } as any)
        let handleCancel
        handleCancel = () =>
          setViewState({
            type: 'list',
            defaultTab,
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          } as any)
        let remoteMenu
        remoteMenu = (
          <MCPRemoteServerMenu
            // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
            server={(viewState as any).server}
            serverToolsCount={serverTools.length}
            onViewTools={handleViewTools}
            onCancel={handleCancel}
            onComplete={onComplete}
          />
        )
        return remoteMenu
      }
    }
    case 'server-tools': {
      let handleSelectTool
      let handleBack
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      handleBack = (_: any, index: number) =>
        setViewState({
          type: 'server-tool-detail',
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          server: (viewState as any).server,
          toolIndex: index,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      handleSelectTool = () =>
        setViewState({
          type: 'server-menu',
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          server: (viewState as any).server,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      let toolListView
      toolListView = (
        <MCPToolListView
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          server={(viewState as any).server}
          onSelectTool={handleBack}
          onBack={handleSelectTool}
        />
      )
      return toolListView
    }
    case 'server-tool-detail': {
      let serverToolsFiltered
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      serverToolsFiltered = filterToolsByServer(mcp.tools, (viewState as any).server.name)
      const serverTools = serverToolsFiltered
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      const tool = serverTools[(viewState as any).toolIndex]
      if (!tool) {
        setViewState({
          type: 'server-tools',
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          server: (viewState as any).server,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
        return null
      }
      let handleBack
      handleBack = () =>
        setViewState({
          type: 'server-tools',
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          server: (viewState as any).server,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      let toolDetailView
      toolDetailView = (
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        <MCPToolDetailView tool={tool} server={(viewState as any).server} onBack={handleBack} />
      )
      return toolDetailView
    }
    case 'agent-server-menu': {
      let handleCancel
      handleCancel = () =>
        setViewState({
          type: 'list',
          defaultTab: 'Agents',
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        } as any)
      let agentServerMenu
      agentServerMenu = (
        <MCPAgentServerMenu
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          agentServer={(viewState as any).agentServer}
          onCancel={handleCancel}
          onComplete={onComplete}
        />
      )
      return agentServerMenu
    }
  }
}
