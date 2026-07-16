import React, { useEffect } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { tSync } from '../../i18n/index.js'
import { ZyAuthProvider } from '../../services/mcp/auth.js'
import type { AgentMcpServerInfo } from '../../services/mcp/viewTypes.js'
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

type ViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo; defaultTab?: string }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }

// biome-ignore lint/suspicious/noExplicitAny: servers are built from MCP client connections with dynamic shapes
type ServerInfo = any

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
  const [viewState, setViewState] = React.useState<ViewState>({ type: 'list' })
  const [servers, setServers] = React.useState<ServerInfo[]>([])
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
      const handleSelectServer = (server: ServerInfo) =>
        setViewState({ type: 'server-menu', server })
      const handleSelectAgentServer = (agentServer: AgentMcpServerInfo) =>
        setViewState({ type: 'agent-server-menu', agentServer })
      return (
        <MCPListPanel
          servers={servers}
          agentServers={agentMcpServers}
          onSelectServer={handleSelectServer}
          onSelectAgentServer={handleSelectAgentServer}
          onComplete={onComplete}
        />
      )
    }
    case 'server-menu': {
      const { server } = viewState
      const serverTools = filterToolsByServer(mcp.tools, server.name)
      const defaultTab = server.transport === 'zyai-proxy' ? 'zy.ai' : 'ZY Code'
      if (server.transport === 'stdio') {
        return (
          <MCPStdioServerMenu
            server={server}
            serverToolsCount={serverTools.length}
            onViewTools={() => setViewState({ type: 'server-tools', server })}
            onCancel={() => setViewState({ type: 'list', defaultTab })}
            onComplete={onComplete}
          />
        )
      }
      return (
        <MCPRemoteServerMenu
          server={server}
          serverToolsCount={serverTools.length}
          onViewTools={() => setViewState({ type: 'server-tools', server })}
          onCancel={() => setViewState({ type: 'list', defaultTab })}
          onComplete={onComplete}
        />
      )
    }
    case 'server-tools': {
      const { server } = viewState
      return (
        <MCPToolListView
          server={server}
          onSelectTool={(_: unknown, index: number) =>
            setViewState({ type: 'server-tool-detail', server, toolIndex: index })
          }
          onBack={() => setViewState({ type: 'server-menu', server })}
        />
      )
    }
    case 'server-tool-detail': {
      const { server, toolIndex } = viewState
      const serverTools = filterToolsByServer(mcp.tools, server.name)
      const tool = serverTools[toolIndex]
      if (!tool) {
        setViewState({ type: 'server-tools', server })
        return null
      }
      return (
        <MCPToolDetailView
          tool={tool}
          server={server}
          onBack={() => setViewState({ type: 'server-tools', server })}
        />
      )
    }
    case 'agent-server-menu': {
      const { agentServer } = viewState
      return (
        <MCPAgentServerMenu
          agentServer={agentServer}
          onCancel={() => setViewState({ type: 'list' })}
          onComplete={onComplete}
        />
      )
    }
  }
}
