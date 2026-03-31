// Stub for @ant/claude-for-chrome-mcp

export const BROWSER_TOOLS: string[] = []

export type Logger = {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

export type PermissionMode = string

export type ClaudeForChromeContext = Record<string, unknown>

export function createClaudeForChromeMcpServer(_opts: unknown): unknown {
  throw new Error('claude-for-chrome-mcp not available in this build')
}
