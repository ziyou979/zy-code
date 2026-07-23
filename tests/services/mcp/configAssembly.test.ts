import { describe, expect, test } from 'bun:test'
import {
  assembleMcpConfigs,
  collectPluginMcpServers,
  type McpConfigAssemblyInput,
  type McpConfigAssemblyPolicy,
} from '../../../src/services/mcp/configAssembly.js'
import type { PluginError } from '../../../src/services/plugins/types.js'
import type { ScopedMcpServerConfig } from '../../../src/services/mcp/types.js'

function server(
  name: string,
  command = 'echo',
  scope: ScopedMcpServerConfig['scope'] = 'user',
): ScopedMcpServerConfig {
  return { name, type: 'stdio', command, args: [], scope } as ScopedMcpServerConfig
}

function emptyInput(): McpConfigAssemblyInput {
  return {
    pluginServers: {},
    dynamicServers: {},
    userServers: {},
    projectServers: {},
    localServers: {},
  }
}

function policy(overrides: Partial<McpConfigAssemblyPolicy> = {}): McpConfigAssemblyPolicy {
  return {
    isDisabled: () => false,
    isDenied: () => false,
    isAllowed: () => true,
    getProjectStatus: () => 'approved',
    log: () => {},
    ...overrides,
  }
}

describe('assembleMcpConfigs', () => {
  test('项目配置只保留 approved 服务器', () => {
    const input = emptyInput()
    input.projectServers = {
      approved: server('approved', 'approved-command', 'project'),
      pending: server('pending', 'pending-command', 'project'),
      rejected: server('rejected', 'rejected-command', 'project'),
    }

    const result = assembleMcpConfigs(
      input,
      policy({
        getProjectStatus: (name) => {
          if (name === 'pending') return 'pending'
          if (name === 'rejected') return 'rejected'
          return 'approved'
        },
      }),
    )

    expect(result.servers.approved).toBeDefined()
    expect(result.servers.pending).toBeUndefined()
    expect(result.servers.rejected).toBeUndefined()
  })

  test('denylist 和 allowlist 作用于所有来源', () => {
    const input = emptyInput()
    input.pluginServers = {
      'plugin:sample:blocked': server('plugin:sample:blocked', 'plugin-command', 'dynamic'),
    }
    input.dynamicServers = {
      'blocked-dynamic': server('blocked-dynamic', 'dynamic-command', 'dynamic'),
    }
    input.userServers = { 'blocked-user': server('blocked-user') }
    input.localServers = {
      allowed: server('allowed', 'allowed-command', 'local'),
      'not-allowed': server('not-allowed', 'other-command', 'local'),
    }

    const result = assembleMcpConfigs(
      input,
      policy({
        isDenied: (name) => name.startsWith('blocked'),
        isAllowed: (name) => name === 'allowed',
      }),
    )

    expect(Object.keys(result.servers)).toEqual(['allowed'])
  })

  test('disabled 配置保留在结果中', () => {
    const input = emptyInput()
    input.userServers = {
      disabled: server('disabled'),
      active: server('active'),
    }

    const result = assembleMcpConfigs(input, policy({ isDisabled: (name) => name === 'disabled' }))

    expect(result.servers.disabled).toBeDefined()
    expect(result.servers.active).toBeDefined()
  })

  test('同时 disabled 且被 policy 阻止的配置不会返回', () => {
    const input = emptyInput()
    input.userServers = { blocked: server('blocked') }

    const result = assembleMcpConfigs(
      input,
      policy({
        isDisabled: () => true,
        isDenied: () => true,
      }),
    )

    expect(result.servers.blocked).toBeUndefined()
  })

  test('active 配置遵循 plugin < dynamic < user < project < local', () => {
    const input = emptyInput()
    input.pluginServers = { shared: server('shared', 'plugin-command', 'dynamic') }
    input.dynamicServers = { shared: server('shared', 'dynamic-command', 'dynamic') }
    input.userServers = { shared: server('shared', 'user-command', 'user') }
    input.projectServers = { shared: server('shared', 'project-command', 'project') }
    input.localServers = { shared: server('shared', 'local-command', 'local') }

    const result = assembleMcpConfigs(input, policy())

    expect(result.servers.shared).toMatchObject({
      command: 'local-command',
      scope: 'local',
    })
  })

  test('disabled 配置保持与 active 相同的 scope 优先级', () => {
    const input = emptyInput()
    input.dynamicServers = { shared: server('shared', 'dynamic-command', 'dynamic') }
    input.userServers = { shared: server('shared', 'user-command', 'user') }
    input.localServers = { shared: server('shared', 'local-command', 'local') }

    const result = assembleMcpConfigs(input, policy({ isDisabled: () => true }))

    expect(result.servers.shared).toMatchObject({
      command: 'local-command',
      scope: 'local',
    })
  })

  test('dynamic 与插件签名相同时 dynamic 胜出并生成正式 suppression error', () => {
    const input = emptyInput()
    input.pluginServers = {
      'plugin:sample:server': server('plugin:sample:server', 'same-command', 'dynamic'),
    }
    input.dynamicServers = {
      dynamic: server('dynamic', 'same-command', 'dynamic'),
    }

    const result = assembleMcpConfigs(input, policy())

    expect(result.servers['plugin:sample:server']).toBeUndefined()
    expect(result.servers.dynamic).toBeDefined()
    expect(result.errors).toContainEqual({
      type: 'mcp-server-suppressed-duplicate',
      source: 'plugin:sample:server',
      plugin: 'sample',
      serverName: 'server',
      duplicateOf: 'dynamic',
    })
  })
})

describe('collectPluginMcpServers', () => {
  test('并行收集所有插件返回的服务器并共享错误集合', async () => {
    const errors: PluginError[] = []
    const plugins = ['first', 'second']

    const result = await collectPluginMcpServers(plugins, errors, async (plugin, sharedErrors) => {
      expect(sharedErrors).toBe(errors)
      return {
        [`plugin:${plugin}:server`]: server(
          `plugin:${plugin}:server`,
          `${plugin}-command`,
          'dynamic',
        ),
      }
    })

    expect(Object.keys(result)).toEqual(['plugin:first:server', 'plugin:second:server'])
  })

  test('插件没有 MCP 配置时跳过 undefined', async () => {
    const result = await collectPluginMcpServers(['empty'], [], async () => undefined)

    expect(result).toEqual({})
  })
})
