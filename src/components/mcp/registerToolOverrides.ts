import { feature } from 'bun:bundle'
import { registerMCPToolOverrideResolvers } from '../../services/mcp/toolOverrideRegistry.js'

/** 注册 UI 侧 MCP 工具适配器，同时保留 feature 构建期裁剪。 */
export function registerMCPToolOverrides(): void {
  registerMCPToolOverrideResolvers({
    claudeInChrome: (toolName) => {
      const rendering =
        require('./claude-in-chrome-rendering.js') as typeof import('./claude-in-chrome-rendering.js')
      return rendering.getClaudeInChromeMCPToolOverrides(toolName)
    },
    computerUse: feature('CHICAGO_MCP')
      ? (toolName) => {
          const overrides =
            require('./computer-use-overrides.js') as typeof import('./computer-use-overrides.js')
          return overrides.getComputerUseMCPToolOverrides(toolName)
        }
      : undefined,
  })
}
