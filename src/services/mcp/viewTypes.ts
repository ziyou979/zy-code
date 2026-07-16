// MCP 视图与服务共享的展示契约。

import type { MCPServerConnection } from './types.js'

export type ConfigScope =
  | 'user'
  | 'project'
  | 'local'
  | 'dynamic'
  | 'enterprise'
  | 'zyai'
  | 'managed'

export interface ServerInfo {
  name: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  error?: string
  scope: ConfigScope
  pluginSource?: string
  tools?: Array<{ name: string; description?: string }>
  client: MCPServerConnection
}

export interface AgentMcpServerInfo extends ServerInfo {
  agentId: string
  agentName: string
  sourceAgents: string[]
  needsAuth?: boolean
  transport?: 'stdio' | 'sse' | 'http'
  url?: string
  command?: string
  isAuthenticated?: boolean
}

export interface ZyAIServerInfo {
  type: 'zyai'
  name: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  scope: ConfigScope
  url: string
}

export interface HTTPServerInfo {
  type: 'http'
  name: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  scope: ConfigScope
  url: string
  headers?: Record<string, string>
}

export interface SSEServerInfo {
  type: 'sse'
  name: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  scope: ConfigScope
  url: string
}

export interface StdioServerInfo {
  type: 'stdio'
  name: string
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  scope: ConfigScope
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface MCPViewState {
  selectedServer?: ServerInfo
  isEditing?: boolean
  isAdding?: boolean
}

export interface MCPServerOption {
  name: string
  scope: string
  enabled: boolean
}
