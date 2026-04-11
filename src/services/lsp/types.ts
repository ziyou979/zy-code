// LSP Types

export interface LSPDiagnostic {
  message: string
  severity: number
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface LSPServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

// Alias for lowercase import
export type LspServerConfig = LSPServerConfig

export interface ScopedLspServerConfig extends LSPServerConfig {
  scope: 'user' | 'project' | 'local' | 'dynamic' | 'enterprise' | 'zyai' | 'managed'
  pluginSource?: string
}

export interface LSPServerInfo {
  name: string
  config: LSPServerConfig
  status: 'running' | 'stopped' | 'error'
}
