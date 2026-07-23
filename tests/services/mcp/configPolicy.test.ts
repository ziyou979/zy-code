/**
 * MCP 配置策略 characterization tests。
 *
 * 这些测试记录 configPolicy.ts 各纯函数的**当前行为**，不假设"正确的策略应该是什么"。
 * 如果行为与产品预期冲突，应单独形成行为修复决策，不得在纯结构迁移中顺手改变。
 *
 * 覆盖范围：
 *   - unwrapCcrProxyUrl       CCR 代理 URL 还原
 *   - getMcpServerSignature   stdio / url 签名生成
 *   - dedupPluginMcpServers   插件与手动配置去重
 *   - dedupZyAIMcpServers     zy.ai 连接器与手动配置去重
 *   - isMcpServerDenied       名称 / 命令 / URL 匹配黑名单
 *   - isMcpServerAllowedByPolicy  白名单 + 黑名单联合判定
 *   - filterMcpServersByPolicy    SDK 豁免 + 策略过滤
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { SettingsJson } from '../../../src/services/settings/types.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../../src/services/mcp/types.js'
import {
  dedupPluginMcpServers,
  dedupZyAIMcpServers,
  getMcpServerSignature,
  mergeMcpConfigsByPriority,
  mergeZyAIMcpConfigs,
  selectEnterpriseMcpServers,
  unwrapCcrProxyUrl,
} from '../../../src/services/mcp/configMerge.js'
import {
  filterMcpServersByPolicy,
  isMcpServerAllowedByPolicy,
  isMcpServerDenied,
} from '../../../src/services/mcp/configPolicy.js'

// ===========================================================================
//  类型辅助
// ===========================================================================
type ScopedServer = Record<string, ScopedMcpServerConfig>

// ---------------------------------------------------------------------------
//  unwrapCcrProxyUrl
// ---------------------------------------------------------------------------
describe('unwrapCcrProxyUrl', () => {
  test('非代理 URL 原样返回', () => {
    expect(unwrapCcrProxyUrl('https://api.example.com/mcp')).toBe('https://api.example.com/mcp')
  })

  test('普通路径不受影响', () => {
    expect(unwrapCcrProxyUrl('/v2/session/shttp/mcp/')).toBe('/v2/session/shttp/mcp/')
  })

  test('CCR 代理 URL 提取 mcp_url 参数', () => {
    const url =
      'https://proxy.example.com/v2/session_ingress/shttp/mcp/path?mcp_url=https%3A%2F%2Frealserver.com%2Fmcp'
    expect(unwrapCcrProxyUrl(url)).toBe('https://realserver.com/mcp')
  })

  test('CCR 代理 URL 不带 mcp_url 参数时返回自身', () => {
    const url = 'https://proxy.example.com/v2/session_ingress/shttp/mcp/path'
    expect(unwrapCcrProxyUrl(url)).toBe(url)
  })

  test('ccr-sessions 标记也能触发代理还原', () => {
    const url =
      'https://proxy.example.com/v2/ccr-sessions/abc123?mcp_url=https%3A%2F%2Fvendor.com%2Fapi'
    expect(unwrapCcrProxyUrl(url)).toBe('https://vendor.com/api')
  })

  test('无效 URL 调用 new URL 不抛异常，返回自身', () => {
    // 虽然 new URL 可能对某些畸形输入抛异常，catch 分支返回原值
    const malformed = '\x00null'
    // 只要能走到 catch 就返回原值
    const result = unwrapCcrProxyUrl(malformed)
    expect(result).toBe(malformed)
  })
})

// ---------------------------------------------------------------------------
//  getMcpServerSignature
// ---------------------------------------------------------------------------
describe('getMcpServerSignature', () => {
  test('stdio 服务器签名包含命令和参数', () => {
    const config: McpServerConfig = {
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/data'],
    }
    const sig = getMcpServerSignature(config)
    expect(sig).toStartWith('stdio:')
    expect(sig).toContain('npx')
    expect(sig).toContain('server-filesystem')
  })

  test('stdio 无 args 时只包含 command', () => {
    const config: McpServerConfig = { command: 'node', args: [] }
    const sig = getMcpServerSignature(config)
    expect(sig).toMatch(/^stdio:\["node"\]$/)
  })

  test('显式 type: stdio 也能识别', () => {
    const config: McpServerConfig = { type: 'stdio', command: 'uvx', args: [] }
    expect(getMcpServerSignature(config)).toMatch(/^stdio:/)
  })

  test('URL 类型服务器返回 url: 签名', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://mcp.example.com/sse' }
    expect(getMcpServerSignature(config)).toBe('url:https://mcp.example.com/sse')
  })

  test('http 类型也使用 URL 签名', () => {
    const config: McpServerConfig = { type: 'http', url: 'https://api.example.com/mcp' }
    expect(getMcpServerSignature(config)).toBe('url:https://api.example.com/mcp')
  })

  test('ws 类型也使用 URL 签名', () => {
    const config: McpServerConfig = { type: 'ws', url: 'wss://ws.example.com/mcp' }
    expect(getMcpServerSignature(config)).toBe('url:wss://ws.example.com/mcp')
  })

  test('CCR 代理 URL 在签名中会被还原', () => {
    const config: McpServerConfig = {
      type: 'sse',
      url: 'https://proxy.example.com/v2/session_ingress/shttp/mcp/path?mcp_url=https%3A%2F%2Frealserver.com%2Fmcp',
    }
    const sig = getMcpServerSignature(config)
    expect(sig).toBe('url:https://realserver.com/mcp')
  })

  test('sdk 类型返回 null', () => {
    const config: McpServerConfig = { type: 'sdk', name: 'test-sdk' }
    expect(getMcpServerSignature(config)).toBeNull()
  })

  test('既无 command 又无 url 的类型返回 null', () => {
    const config = { type: 'sse-ide' } as McpServerConfig
    expect(getMcpServerSignature(config)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
//  dedupPluginMcpServers
// ---------------------------------------------------------------------------
describe('dedupPluginMcpServers', () => {
  const logs: string[] = []
  const log = (msg: string) => {
    logs.push(msg)
  }

  function pluginServer(name: string, command: string): any {
    return { command, args: [], scope: 'dynamic', name }
  }

  function manualServer(name: string, command: string): any {
    return { command, args: [], scope: 'user', name }
  }

  beforeEach(() => {
    logs.length = 0
  })

  test('无冲突时保留所有插件服务器', () => {
    const plugins = {
      'plugin:a:server1': pluginServer('plugin:a:server1', 'tool-a'),
      'plugin:b:server2': pluginServer('plugin:b:server2', 'tool-b'),
    }
    const { servers, suppressed } = dedupPluginMcpServers(plugins, {}, log)
    expect(Object.keys(servers)).toHaveLength(2)
    expect(suppressed).toHaveLength(0)
  })

  test('与手动配置签名相同的手动胜出，插件被压制', () => {
    const plugins = {
      'plugin:x:dup': pluginServer('plugin:x:dup', 'node server.js'),
    }
    const manuals = {
      'my-server': manualServer('my-server', 'node server.js'),
    }
    const { servers, suppressed } = dedupPluginMcpServers(plugins, manuals, log)
    expect(servers).not.toHaveProperty('plugin:x:dup')
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]!.duplicateOf).toBe('my-server')
  })

  test('插件之间签名相同则先加载的胜出', () => {
    const plugins = {
      'plugin:a:first': pluginServer('plugin:a:first', 'same-command'),
      'plugin:b:second': pluginServer('plugin:b:second', 'same-command'),
    }
    const { servers, suppressed } = dedupPluginMcpServers(plugins, {}, log)
    expect(servers).toHaveProperty('plugin:a:first')
    expect(servers).not.toHaveProperty('plugin:b:second')
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]!.duplicateOf).toBe('plugin:a:first')
  })

  test('signature 为 null 的 SDK 插件不会被压制（不被校验签名）', () => {
    const plugins = {
      'plugin:sdk:svc': { type: 'sdk' as const, scope: 'dynamic' as const, name: 'svc' },
    }
    const { servers, suppressed } = dedupPluginMcpServers(plugins, {}, log)
    expect(servers).toHaveProperty('plugin:sdk:svc')
    expect(suppressed).toHaveLength(0)
  })

  test('手动与插件 command 相同但手动 args 不同则不被视作重复', () => {
    const plugins = {
      'plugin:c:c1': pluginServer('plugin:c:c1', 'node app.js'),
    }
    const manuals = {
      different: { ...manualServer('different', 'node app.js'), args: ['--port', '9090'] },
    }
    const { servers, suppressed } = dedupPluginMcpServers(plugins, manuals, log)
    expect(servers).toHaveProperty('plugin:c:c1')
    expect(suppressed).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
//  dedupZyAIMcpServers
// ---------------------------------------------------------------------------
describe('dedupZyAIMcpServers', () => {
  const logs: string[] = []
  const log = (msg: string) => {
    logs.push(msg)
  }
  const enabledTrue = () => false
  const disabledManual = (name: string) => name === 'disabled-manual'

  function zyAiServer(name: string, url: string): any {
    return { type: 'sse', url, scope: 'zyai', name }
  }
  function manualServer(name: string, url: string): any {
    return { type: 'sse', url, scope: 'user', name }
  }

  beforeEach(() => {
    logs.length = 0
  })

  test('无冲突时保留所有 zy.ai 连接器', () => {
    const zyAi = {
      'zy.ai Slack': zyAiServer('zy.ai Slack', 'https://mcp.slack.com'),
      'zy.ai GitHub': zyAiServer('zy.ai GitHub', 'https://mcp.github.com'),
    }
    const { servers, suppressed } = dedupZyAIMcpServers(zyAi, {}, enabledTrue, log)
    expect(Object.keys(servers)).toHaveLength(2)
    expect(suppressed).toHaveLength(0)
  })

  test('与已启用手动服务器同 URL 的 zy.ai 连接器被压制', () => {
    const zyAi = {
      'zy.ai Slack': zyAiServer('zy.ai Slack', 'https://mcp.slack.com'),
    }
    const manuals = {
      slack: manualServer('slack', 'https://mcp.slack.com'),
    }
    const { servers, suppressed } = dedupZyAIMcpServers(zyAi, manuals, enabledTrue, log)
    expect(servers['zy.ai Slack']).toBeUndefined()
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]!.duplicateOf).toBe('slack')
  })

  test('禁用的手动服务器不压制 zy.ai 连接器', () => {
    const zyAi = {
      'zy.ai DB': zyAiServer('zy.ai DB', 'https://mcp.db.com'),
    }
    const manuals = {
      'disabled-manual': manualServer('disabled-manual', 'https://mcp.db.com'),
    }
    const { servers, suppressed } = dedupZyAIMcpServers(zyAi, manuals, disabledManual, log)
    expect(servers['zy.ai DB']).toBeDefined()
    expect(suppressed).toHaveLength(0)
  })

  test('签名不同的 zy.ai 连接器不会被压制', () => {
    const zyAi = {
      'zy.ai Foo': zyAiServer('zy.ai Foo', 'https://foo.example.com/mcp'),
    }
    const manuals = {
      bar: manualServer('bar', 'https://bar.example.com/mcp'),
    }
    const { servers, suppressed } = dedupZyAIMcpServers(zyAi, manuals, enabledTrue, log)
    expect(servers['zy.ai Foo']).toBeDefined()
    expect(suppressed).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
//  isMcpServerDenied
// ---------------------------------------------------------------------------
describe('isMcpServerDenied', () => {
  const noDenyList = () => ({}) as SettingsJson
  const denyByName = () =>
    ({
      deniedMcpServers: [{ serverName: 'blocked-server' }],
    }) as SettingsJson
  const denyByCommand = () =>
    ({
      deniedMcpServers: [{ serverCommand: ['malicious', '--attack'] }],
    }) as SettingsJson
  const denyByUrl = () =>
    ({
      deniedMcpServers: [{ serverUrl: 'https://evil.example.com/*' }],
    }) as SettingsJson
  const denyAllThree = () =>
    ({
      deniedMcpServers: [
        { serverName: 'blocked-server' },
        { serverCommand: ['malicious', '--attack'] },
        { serverUrl: 'https://evil.example.com/*' },
      ],
    }) as SettingsJson

  test('空黑名单不会拒绝任何服务器', () => {
    expect(isMcpServerDenied('anything', noDenyList)).toBe(false)
  })

  test('名称匹配被拒绝', () => {
    expect(isMcpServerDenied('blocked-server', denyByName)).toBe(true)
  })

  test('名称不匹配不被拒绝', () => {
    expect(isMcpServerDenied('good-server', denyByName)).toBe(false)
  })

  test('命令匹配被拒绝', () => {
    const config: McpServerConfig = { command: 'malicious', args: ['--attack'] }
    expect(isMcpServerDenied('whatever', denyByCommand, config)).toBe(true)
  })

  test('命令数组长度不同不被拒绝', () => {
    const config: McpServerConfig = { command: 'malicious', args: ['--attack', '--extra'] }
    expect(isMcpServerDenied('whatever', denyByCommand, config)).toBe(false)
  })

  test('不带 config 时不检查命令/URL 黑名单', () => {
    expect(isMcpServerDenied('whatever', denyByCommand)).toBe(false)
  })

  test('URL 通配符匹配被拒绝', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://evil.example.com/mcp' }
    expect(isMcpServerDenied('server', denyByUrl, config)).toBe(true)
  })

  test('URL 不匹配通配符不被拒绝', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://safe.example.com/mcp' }
    expect(isMcpServerDenied('server', denyByUrl, config)).toBe(false)
  })

  test('sdk 类型 config 且无 url 字段时 URL 匹配跳过', () => {
    const config: McpServerConfig = { type: 'sdk', name: 'sdk-svc' }
    expect(isMcpServerDenied('sdk-svc', denyByUrl)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
//  isMcpServerAllowedByPolicy
// ---------------------------------------------------------------------------
describe('isMcpServerAllowedByPolicy', () => {
  const noLists = () => ({}) as SettingsJson
  const allowAll = () => ({}) as SettingsJson
  const allowByName = () =>
    ({
      allowedMcpServers: [{ serverName: 'allowed-server' }],
    }) as SettingsJson
  const emptyAllow = () =>
    ({
      allowedMcpServers: [],
    }) as SettingsJson
  const allowByCommand = () =>
    ({
      allowedMcpServers: [{ serverCommand: ['safe-tool'] }],
    }) as SettingsJson
  const allowByUrl = () =>
    ({
      allowedMcpServers: [{ serverUrl: 'https://*.trusted.com/*' }],
    }) as SettingsJson
  const denyByName = () =>
    ({
      deniedMcpServers: [{ serverName: 'blocked-server' }],
    }) as SettingsJson

  test('无白名单时允许所有服务器', () => {
    expect(isMcpServerAllowedByPolicy('anything', allowAll, noLists)).toBe(true)
  })

  test('空白名单拒绝所有', () => {
    expect(isMcpServerAllowedByPolicy('anything', emptyAllow, noLists)).toBe(false)
  })

  test('名称在白名单中允许', () => {
    expect(isMcpServerAllowedByPolicy('allowed-server', allowByName, noLists)).toBe(true)
  })

  test('名称不在白名单中拒绝', () => {
    expect(isMcpServerAllowedByPolicy('unknown', allowByName, noLists)).toBe(false)
  })

  test('黑名单优先于白名单', () => {
    const both = () =>
      ({
        allowedMcpServers: [{ serverName: 'blocked-server' }],
      }) as SettingsJson
    // 即使名字在白名单中，黑名单也会先拒绝
    expect(isMcpServerAllowedByPolicy('blocked-server', both, denyByName)).toBe(false)
  })

  test('白名单含命令条目时按命令匹配而非名称', () => {
    const config: McpServerConfig = { command: 'safe-tool', args: [] }
    // 仅命令匹配，名称不匹配
    expect(isMcpServerAllowedByPolicy('anything', allowByCommand, noLists, config)).toBe(true)
  })

  test('白名单含命令条目时名称不匹配且命令不匹配拒绝', () => {
    const config: McpServerConfig = { command: 'unsafe-tool', args: [] }
    expect(isMcpServerAllowedByPolicy('anything', allowByCommand, noLists, config)).toBe(false)
  })

  test('白名单含 URL 条目时按 URL 匹配', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://app.trusted.com/mcp' }
    expect(isMcpServerAllowedByPolicy('srv', allowByUrl, noLists, config)).toBe(true)
  })

  test('白名单含 URL 条目时 URL 不匹配拒绝', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://evil.com/mcp' }
    expect(isMcpServerAllowedByPolicy('srv', allowByUrl, noLists, config)).toBe(false)
  })

  test('无 config 时按名称匹配白名单', () => {
    expect(isMcpServerAllowedByPolicy('allowed-server', allowByName, noLists)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
//  selectEnterpriseMcpServers
// ---------------------------------------------------------------------------
describe('selectEnterpriseMcpServers', () => {
  const allowAll = () => true
  const denySdk = (_name: string, config: McpServerConfig) => config?.type !== 'sdk'

  test('企业不存在时返回 null', () => {
    const result = selectEnterpriseMcpServers({}, false, allowAll)
    expect(result).toBeNull()
  })

  test('企业存在时返回过滤后的服务器', () => {
    const enterprise = {
      'data-svc': {
        command: 'data-tool',
        args: [],
        scope: 'enterprise' as const,
      } as ScopedMcpServerConfig,
    }
    const result = selectEnterpriseMcpServers(enterprise, true, allowAll)
    expect(result).not.toBeNull()
    expect(result!.servers).toHaveProperty('data-svc')
  })

  test('企业存在但服务器为空时返回空 servers', () => {
    const result = selectEnterpriseMcpServers({}, true, allowAll)
    expect(result).not.toBeNull()
    expect(Object.keys(result!.servers)).toHaveLength(0)
  })

  test('策略拒绝的服务器被过滤掉', () => {
    const enterprise = {
      'sdk-svc': {
        type: 'sdk' as const,
        name: 'sdk-svc',
        scope: 'enterprise' as const,
      } as ScopedMcpServerConfig,
      'safe-tool': {
        command: 'safe',
        args: [],
        scope: 'enterprise' as const,
      } as ScopedMcpServerConfig,
    }
    const result = selectEnterpriseMcpServers(enterprise, true, denySdk)
    expect(result!.servers).not.toHaveProperty('sdk-svc')
    expect(result!.servers).toHaveProperty('safe-tool')
  })

  test('所有企业服务器都被拒绝时返回空 servers', () => {
    const enterprise = {
      'sdk-svc': {
        type: 'sdk' as const,
        name: 'sdk-svc',
        scope: 'enterprise' as const,
      } as ScopedMcpServerConfig,
    }
    const result = selectEnterpriseMcpServers(enterprise, true, denySdk)
    expect(Object.keys(result!.servers)).toHaveLength(0)
  })

  test('不返回非企业来源的服务器（仅过滤已传入的服务器）', () => {
    const enterprise = {
      'only-enterprise': {
        command: 'ent',
        args: [],
        scope: 'enterprise' as const,
      } as ScopedMcpServerConfig,
    }
    const result = selectEnterpriseMcpServers(enterprise, true, allowAll)
    expect(result!.servers).toHaveProperty('only-enterprise')
    expect(Object.keys(result!.servers)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
//  Scope 优先级（merge 顺序）
// ---------------------------------------------------------------------------
describe('scope 优先级合并', () => {
  function pluginSrv(name: string, command: string): ScopedMcpServerConfig {
    return { command, args: [], scope: 'dynamic' } as ScopedMcpServerConfig
  }
  function userSrv(name: string, command: string): ScopedMcpServerConfig {
    return { command, args: [], scope: 'user' } as ScopedMcpServerConfig
  }
  function projectSrv(name: string, command: string): ScopedMcpServerConfig {
    return { command, args: [], scope: 'project' } as ScopedMcpServerConfig
  }
  function localSrv(name: string, command: string): ScopedMcpServerConfig {
    return { command, args: [], scope: 'local' } as ScopedMcpServerConfig
  }

  test('同名 server 时 local 覆盖 project 覆盖 user 覆盖 plugin', () => {
    const merged = mergeMcpConfigsByPriority(
      { 'my-srv': pluginSrv('my-srv', 'plugin-ver') },
      { 'my-srv': userSrv('my-srv', 'user-ver') },
      { 'my-srv': projectSrv('my-srv', 'project-ver') },
      { 'my-srv': localSrv('my-srv', 'local-ver') },
    )
    expect((merged['my-srv'] as Record<string, unknown>).command).toBe('local-ver')
    expect((merged['my-srv'] as Record<string, unknown>).scope).toBe('local')
  })

  test('缺少某层时自动 fallthrough', () => {
    const merged = mergeMcpConfigsByPriority(
      { api: pluginSrv('api', 'plugin-ver') },
      {}, // 无 user
      {}, // 无 project
      { api: localSrv('api', 'local-ver') },
    )
    expect((merged['api'] as Record<string, unknown>).command).toBe('local-ver')
  })

  test('不同 scope 同名 server 类型不同时仍被覆盖', () => {
    const user: ScopedServer = {
      'data-svc': { type: 'sse', url: 'https://user.example.com/mcp', scope: 'user' },
    }
    const local: ScopedServer = {
      'data-svc': { command: 'local-binary', args: [], scope: 'local' },
    }
    const merged = mergeMcpConfigsByPriority({}, user, {}, local)
    expect(merged['data-svc']).toBe(local['data-svc'])
    expect(merged['data-svc']).not.toHaveProperty('url')
  })

  test('zy.ai 连接器在手动配置之后作为最低优先级合并', () => {
    const zyAi: ScopedServer = {
      'zy.ai DataSvc': { type: 'sse', url: 'https://zyai.example.com/mcp', scope: 'zyai' },
    }
    const manual: ScopedServer = {
      'data-svc': { command: 'manual-tool', args: [], scope: 'user' },
    }
    const merged = mergeZyAIMcpConfigs(zyAi, manual)
    expect(merged['data-svc']).toBeDefined()
    expect((merged['data-svc'] as Record<string, unknown>).command).toBe('manual-tool')
    expect(merged['zy.ai DataSvc']).toBeDefined()
  })

  test('dedupZyAIMcpServers 已启用手动配置压制同签名 zy.ai 连接器', () => {
    const zyAi: ScopedServer = {
      'zy.ai API': { type: 'sse', url: 'https://api.example.com/mcp', scope: 'zyai' },
    }
    const manual: ScopedServer = {
      'my-api': { type: 'sse', url: 'https://api.example.com/mcp', scope: 'user' },
    }
    const log = () => {}
    const { servers, suppressed } = dedupZyAIMcpServers(zyAi, manual, () => false, log)
    expect(servers['zy.ai API']).toBeUndefined()
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]!.duplicateOf).toBe('my-api')
  })

  test('禁用的手动服务器不压制 zy.ai 连接器', () => {
    const zyAi: ScopedServer = {
      'zy.ai DB': { type: 'sse', url: 'https://db.example.com/mcp', scope: 'zyai' },
    }
    const manual: ScopedServer = {
      'my-db': { type: 'sse', url: 'https://db.example.com/mcp', scope: 'user' },
    }
    const log = () => {}
    const { servers } = dedupZyAIMcpServers(
      zyAi,
      manual,
      (name: string) => name === 'my-db', // 已禁用
      log,
    )
    // zy.ai 连接器保留，因为手动服务器被禁用
    expect(servers['zy.ai DB']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
//  filterMcpServersByPolicy
// ---------------------------------------------------------------------------
describe('filterMcpServersByPolicy', () => {
  const alwaysBlock = (_name: string, config?: McpServerConfig) => {
    return config?.type === 'sdk' // SDK 始终允许
  }
  const allowSdkOnly: (name: string, config?: McpServerConfig) => boolean = (name, config) =>
    config?.type === 'sdk' || name === 'special'

  test('SDK 服务器始终被豁免', () => {
    const configs = {
      'sdk-svc': { type: 'sdk' as const, name: 'sdk-svc' },
    }
    const { allowed, blocked } = filterMcpServersByPolicy(configs, alwaysBlock)
    expect(allowed).toHaveProperty('sdk-svc')
    expect(blocked).toHaveLength(0)
  })

  test('非 SDK 服务器被策略阻止', () => {
    const configs = {
      'stdio-tool': { command: 'npx', name: 'stdio-tool' },
    }
    const { allowed, blocked } = filterMcpServersByPolicy(configs, alwaysBlock)
    expect(allowed).not.toHaveProperty('stdio-tool')
    expect(blocked).toContain('stdio-tool')
  })

  test('混合场景正确分类', () => {
    const configs = {
      'sdk-svc': { type: 'sdk' as const, name: 'sdk-svc' },
      'special-tool': { command: 'special', name: 'special-tool' },
      'blocked-tool': { command: 'bad', name: 'blocked-tool' },
    }
    const { allowed, blocked } = filterMcpServersByPolicy(
      configs,
      (name) => name === 'special-tool' || name === 'sdk-svc',
    )
    expect(allowed).toHaveProperty('sdk-svc')
    expect(allowed).toHaveProperty('special-tool')
    expect(allowed).not.toHaveProperty('blocked-tool')
    expect(blocked).toContain('blocked-tool')
  })
})
