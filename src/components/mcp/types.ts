// MCP Component Types

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
}

export interface AgentMcpServerInfo extends ServerInfo {
  agentId: string
  agentName: string
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
