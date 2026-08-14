import { createContext, type ReactNode, useContext } from 'react'
import type { Command } from '../../commands/index.js'
import type { Tool } from '../../tools/tool.js'
import type { MCPServerConnection, ScopedMcpServerConfig, ServerResource } from './types.js'
import { useManageMCPConnections } from './useManageMCPConnections.js'

interface MCPConnectionContextValue {
  reconnectMcpServer: (serverName: string) => Promise<{
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }>
  toggleMcpServer: (serverName: string) => Promise<void>
}
const MCPConnectionContext = createContext<MCPConnectionContextValue | null>(null)
export function useMcpReconnect() {
  const context = useContext(MCPConnectionContext)
  if (!context) {
    throw new Error('useMcpReconnect must be used within MCPConnectionManager')
  }
  return context.reconnectMcpServer
}
export function useMcpToggleEnabled() {
  const context = useContext(MCPConnectionContext)
  if (!context) {
    throw new Error('useMcpToggleEnabled must be used within MCPConnectionManager')
  }
  return context.toggleMcpServer
}
interface MCPConnectionManagerProps {
  children: ReactNode
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  isStrictMcpConfig: boolean
}

// TODO (ollie)：可考虑将这些函数放入 app state，从而移除此 context
export function MCPConnectionManager({
  children,
  dynamicMcpConfig,
  isStrictMcpConfig,
}: MCPConnectionManagerProps) {
  const { reconnectMcpServer, toggleMcpServer } = useManageMCPConnections(
    dynamicMcpConfig,
    isStrictMcpConfig,
  )
  const value = {
    reconnectMcpServer,
    toggleMcpServer,
  }
  return <MCPConnectionContext.Provider value={value}>{children}</MCPConnectionContext.Provider>
}
