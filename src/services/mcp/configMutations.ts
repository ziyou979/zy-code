/**
 * MCP 配置修改操作：添加与删除 MCP 服务器。
 *
 * 从 config.ts 中提取，负责 CRUD 操作和前置校验。
 */
import { feature } from 'bun:bundle'
import { isClaudeInChromeMCPServer } from '../claude-in-chrome/common.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../config/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import {
  getMcpConfigsByScope as getMcpConfigsByScopeCore,
  getProjectMcpConfigsFromCwd as getProjectMcpConfigsFromCwdCore,
  writeMcpjsonFile,
} from './configRepository.js'
import { doesEnterpriseMcpConfigExist } from './configLookup.js'
import { mcpPolicyAdapter } from './configPolicy.js'
import { McpServerConfigSchema } from './types.js'
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from './types.js'

export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
): Promise<void> {
  if (name.match(/[^a-zA-Z0-9_-]/)) {
    throw new Error(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }

  if (isClaudeInChromeMCPServer(name)) {
    throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
  }

  if (feature('CHICAGO_MCP')) {
    const { isComputerUseMCPServer } = await import('../computer-use/common.js')
    if (isComputerUseMCPServer(name)) {
      throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
    }
  }

  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers`,
    )
  }

  const result = McpServerConfigSchema().safeParse(config)
  if (!result.success) {
    const formattedErrors = result.error.issues
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ')
    throw new Error(`Invalid configuration: ${formattedErrors}`)
  }
  const validatedConfig = result.data

  if (mcpPolicyAdapter.isMcpServerDenied(name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`,
    )
  }

  if (!mcpPolicyAdapter.isMcpServerAllowedByPolicy(name, validatedConfig)) {
    throw new Error(`Cannot add MCP server "${name}": not allowed by enterprise policy`)
  }

  switch (scope) {
    case 'project': {
      const { servers } = getProjectMcpConfigsFromCwdCore()
      if (servers[name]) {
        throw new Error(`MCP server ${name} already exists in .mcp.json`)
      }
      break
    }
    case 'user': {
      const globalConfig = getGlobalConfig()
      if (globalConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in user config`)
      }
      break
    }
    case 'local': {
      const projectConfig = getCurrentProjectConfig()
      if (projectConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in local config`)
      }
      break
    }
    case 'dynamic':
      throw new Error('Cannot add MCP server to scope: dynamic')
    case 'enterprise':
      throw new Error('Cannot add MCP server to scope: enterprise')
    case 'zyai':
      throw new Error('Cannot add MCP server to scope: zyai')
  }

  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwdCore()
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(existingServers)) {
        const { scope: _, ...configWithoutScope } = serverConfig
        mcpServers[serverName] = configWithoutScope
      }
      mcpServers[name] = validatedConfig
      try {
        await writeMcpjsonFile({ mcpServers })
      } catch (error) {
        throw new Error(`Failed to write to .mcp.json: ${error}`)
      }
      break
    }
    case 'user': {
      saveGlobalConfig((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }
    case 'local': {
      saveCurrentProjectConfig((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }
    default:
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
}

export async function removeMcpConfig(name: string, scope: ConfigScope): Promise<void> {
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwdCore()
      if (!existingServers[name]) {
        throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
      }
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(existingServers)) {
        if (serverName !== name) {
          const { scope: _, ...configWithoutScope } = serverConfig
          mcpServers[serverName] = configWithoutScope
        }
      }
      try {
        await writeMcpjsonFile({ mcpServers })
      } catch (error) {
        throw new Error(`Failed to remove from .mcp.json: ${error}`)
      }
      break
    }
    case 'user': {
      const config = getGlobalConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No user-scoped MCP server found with name: ${name}`)
      }
      saveGlobalConfig((current) => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return { ...current, mcpServers: restMcpServers }
      })
      break
    }
    case 'local': {
      const config = getCurrentProjectConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No project-local MCP server found with name: ${name}`)
      }
      saveCurrentProjectConfig((current) => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return { ...current, mcpServers: restMcpServers }
      })
      break
    }
    default:
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
}
