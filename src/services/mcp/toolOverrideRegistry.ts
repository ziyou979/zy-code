import type { Tool } from '../../tool.js'

export type MCPToolOverrides = Partial<Tool>
export type MCPToolOverrideResolver = (toolName: string) => MCPToolOverrides

let claudeInChromeResolver: MCPToolOverrideResolver | undefined
let computerUseResolver: MCPToolOverrideResolver | undefined

/** 由 UI 组合入口注入 MCP 工具的展示与审批适配器。 */
export function registerMCPToolOverrideResolvers(resolvers: {
  claudeInChrome: MCPToolOverrideResolver
  computerUse?: MCPToolOverrideResolver
}): void {
  claudeInChromeResolver = resolvers.claudeInChrome
  computerUseResolver = resolvers.computerUse
}

export function getClaudeInChromeToolOverrides(toolName: string): MCPToolOverrides {
  return claudeInChromeResolver?.(toolName) ?? {}
}

export function getComputerUseToolOverrides(toolName: string): MCPToolOverrides {
  return computerUseResolver?.(toolName) ?? {}
}
