import React, { useEffect } from 'react'
import { tSync } from '../../i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { ZyAuthProvider } from '../../services/mcp/auth.js'
import type {
  McpZyAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
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
    server?: any
    agentServer?: any
    defaultTab?: string
    toolIndex?: number
  }>({
    type: 'list',
  })
  const [servers, setServers] = React.useState([])
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
          let isAuthenticated = undefined
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
      handleSelectServer = (server) =>
        setViewState({
          type: 'server-menu',
          server,
        } as any)
      handleSelectAgentServer = (agentServer) =>
        setViewState({
          type: 'agent-server-menu',
          agentServer,
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
      serverToolsFiltered = filterToolsByServer(mcp.tools, (viewState as any).server.name)
      const serverTools = serverToolsFiltered
      const defaultTab = (viewState as any).server.transport === 'zyai-proxy' ? 'zy.ai' : 'ZY Code'
      if ((viewState as any).server.transport === 'stdio') {
        let handleViewTools
        handleViewTools = () =>
          setViewState({
            type: 'server-tools',
            server: (viewState as any).server,
          } as any)
        let handleCancel
        handleCancel = () =>
          setViewState({
            type: 'list',
            defaultTab,
          } as any)
        let stdioMenu
        stdioMenu = (
          <MCPStdioServerMenu
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
            server: (viewState as any).server,
          } as any)
        let handleCancel
        handleCancel = () =>
          setViewState({
            type: 'list',
            defaultTab,
          } as any)
        let remoteMenu
        remoteMenu = (
          <MCPRemoteServerMenu
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
      handleBack = (_, index) =>
        setViewState({
          type: 'server-tool-detail',
          server: (viewState as any).server,
          toolIndex: index,
        } as any)
      handleSelectTool = () =>
        setViewState({
          type: 'server-menu',
          server: (viewState as any).server,
        } as any)
      let toolListView
      toolListView = (
        <MCPToolListView
          server={(viewState as any).server}
          onSelectTool={handleBack}
          onBack={handleSelectTool}
        />
      )
      return toolListView
    }
    case 'server-tool-detail': {
      let serverToolsFiltered
      serverToolsFiltered = filterToolsByServer(mcp.tools, (viewState as any).server.name)
      const serverTools = serverToolsFiltered
      const tool = serverTools[(viewState as any).toolIndex]
      if (!tool) {
        setViewState({
          type: 'server-tools',
          server: (viewState as any).server,
        } as any)
        return null
      }
      let handleBack
      handleBack = () =>
        setViewState({
          type: 'server-tools',
          server: (viewState as any).server,
        } as any)
      let toolDetailView
      toolDetailView = (
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
        } as any)
      let agentServerMenu
      agentServerMenu = (
        <MCPAgentServerMenu
          agentServer={(viewState as any).agentServer}
          onCancel={handleCancel}
          onComplete={onComplete}
        />
      )
      return agentServerMenu
    }
  }
}
