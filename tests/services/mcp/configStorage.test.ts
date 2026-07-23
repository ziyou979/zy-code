/**
 * MCP 配置存储 characterization tests。
 *
 * 覆盖范围：
 *   - parseMcpConfig          schema 校验、环境变量展开、npx 警告
 *   - parseMcpConfigFromFilePath  文件读取与 JSON 解析降级
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ValidationError } from '../../../src/services/settings/validation.js'
import { parseMcpConfig } from '../../../src/services/mcp/configParsing.js'
import { parseMcpConfigFromFilePath } from '../../../src/services/mcp/configRepository.js'

describe('parseMcpConfig', () => {
  test('有效的 stdio 配置返回 config', () => {
    const input = { mcpServers: { myServer: { command: 'npx', args: ['-y', '@model/tool'] } } }
    const { config, errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'user',
    })
    expect(config).not.toBeNull()
    expect(config!.mcpServers['myServer']).toBeDefined()
    // 在 Windows 上 npx 命令会产生警告，不影响 config 返回
    expect(errors.filter((e) => e.mcpErrorMetadata?.severity !== 'warning')).toHaveLength(0)
  })

  test('有效的 URL 配置返回 config', () => {
    const input = { mcpServers: { remote: { type: 'sse', url: 'https://mcp.example.com/sse' } } }
    const { config, errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'user',
    })
    expect(config).not.toBeNull()
    expect(config!.mcpServers['remote']).toBeDefined()
    expect(errors).toHaveLength(0)
  })

  test('空 mcpServers 返回空 config', () => {
    const input = { mcpServers: {} }
    const { config, errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'user',
    })
    expect(config).not.toBeNull()
    expect(Object.keys(config!.mcpServers)).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  test('无效的 schema 返回 fatal 错误', () => {
    const input = { mcpServers: { bad: { command: 123 } } }
    const { config, errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'project',
      filePath: '/test/.mcp.json',
    })
    expect(config).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.mcpErrorMetadata?.severity).toBe('fatal')
  })

  test('非对象输入返回 schema 错误', () => {
    const { config, errors } = parseMcpConfig({
      configObject: 'not-an-object',
      expandVars: false,
      scope: 'user',
    })
    expect(config).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  test('scope 和 filePath 传递到错误元数据', () => {
    const input = { mcpServers: { bad: { command: 123 } } }
    const { errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'local',
      filePath: '/custom/config.json',
    })
    expect(errors[0]!.file).toBe('/custom/config.json')
    expect(errors[0]!.mcpErrorMetadata?.scope).toBe('local')
  })
})

describe('parseMcpConfig — 环境变量展开', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, MY_MCP_KEY: 'my-value', MISSING_VAR: undefined }
  })

  test('expandVars=false 时不展开环境变量', () => {
    const input = { mcpServers: { svc: { command: '${MY_MCP_KEY}', args: [] } } }
    const { config } = parseMcpConfig({ configObject: input, expandVars: false, scope: 'user' })
    expect((config!.mcpServers['svc'] as { command: string }).command).toBe('${MY_MCP_KEY}')
  })

  test('expandVars=true 时展开存在的环境变量', () => {
    process.env.MY_MCP_KEY = 'my-value'
    const input = { mcpServers: { svc: { command: 'npx', args: ['--key=${MY_MCP_KEY}'] } } }
    const { config } = parseMcpConfig({ configObject: input, expandVars: true, scope: 'user' })
    const cfg = config!.mcpServers['svc']
    // command 不含变量展开所以原样传递
    expect((cfg as { command: string }).command).toBe('npx')
    // args 中的 ${MY_MCP_KEY} 应被展开
    const stdioCfg = cfg as { args: string[] }
    expect(stdioCfg.args[0]).toContain('my-value')
  })

  test('环境变量缺失时产生 warning 错误', () => {
    const input = { mcpServers: { svc: { command: 'tool', args: ['${DOES_NOT_EXIST}'] } } }
    const { errors } = parseMcpConfig({ configObject: input, expandVars: true, scope: 'user' })
    const missingVars = errors.filter((e) => e.mcpErrorMetadata?.severity === 'warning')
    expect(missingVars.length).toBeGreaterThan(0)
    expect(missingVars[0]!.message).toContain('DOES_NOT_EXIST')
  })
})

describe('parseMcpConfig — npx 警告（仅限 Windows）', () => {
  const ORIGINAL_PLATFORM = process.platform

  // 注：此测试只在 Windows 上触发 npx 警告
  // 如果不是 Windows，这些用例只是记录当前行为
  test('Windows 上 npx 命令产生 warning', () => {
    // 本测试只在 process.platform === 'win32' 时验证 npx 警告
    // 在其他平台上它只验证配置解析正常
    const input = { mcpServers: { svc: { command: 'npx', args: ['-y', 'tool'] } } }
    const { config, errors } = parseMcpConfig({
      configObject: input,
      expandVars: false,
      scope: 'user',
    })
    expect(config).not.toBeNull()
    if (process.platform === 'win32') {
      const npxWarnings = errors.filter((e) => e.message.includes('cmd /c'))
      expect(npxWarnings.length).toBeGreaterThan(0)
      expect(npxWarnings[0]!.mcpErrorMetadata?.severity).toBe('warning')
    }
  })

  test('非 npx 命令不影响 Windows 警告', () => {
    const input = { mcpServers: { svc: { command: 'python', args: ['server.py'] } } }
    const { errors } = parseMcpConfig({ configObject: input, expandVars: false, scope: 'user' })
    const npxWarnings = errors.filter((e) => e.message.includes('cmd /c'))
    expect(npxWarnings).toHaveLength(0)
  })
})

describe('parseMcpConfigFromFilePath', () => {
  test('不存在的文件返回 fatal 错误', () => {
    const { config, errors } = parseMcpConfigFromFilePath({
      filePath: '/tmp/__nonexistent_mcp_test__/config.json',
      expandVars: false,
      scope: 'enterprise',
    })
    expect(config).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.mcpErrorMetadata?.severity).toBe('fatal')
    expect(errors[0]!.message).toMatch(/not found/i)
  })
})
