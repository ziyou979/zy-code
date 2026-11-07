import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveDiscoveredModelCapability } from '../../../src/services/settings/discoveredModelCapabilities.js'
import {
  getLocalContextWindow,
  getLocalModelCapability,
  getLocalModelEffortLevels,
  getLocalModelPreserveThinking,
  localModelHasAdaptiveThinking,
  localModelHasCapability,
  getLocalModelInputModalities,
} from '../../../src/services/settings/localModelCapabilities.js'

describe('discoveredModelCapabilities', () => {
  let directory: string
  let previousDirectory: string | undefined
  const selection = {
    model: 'new-model',
    provider: 'generic',
    connectionId: 'personal',
    apiFormat: 'openai-chat' as const,
  }
  const context = {
    provider: 'generic',
    connectionId: 'personal',
    apiFormat: 'openai-chat' as const,
  }
  const capability = {
    capabilities: {
      input: ['text', 'image'] as ['text', 'image'],
      thinking: { effort: ['on'] as ['on'] },
      structured_outputs: true,
    },
    tokens: { contextWindow: 1048576, maxOutputTokens: 262144 },
  }
  beforeEach(() => {
    previousDirectory = process.env.ZY_CONFIG_DIR
    directory = mkdtempSync(join(tmpdir(), 'zy-discovered-capabilities-'))
    process.env.ZY_CONFIG_DIR = directory
    mkdirSync(join(directory, 'model-capabilities'))
  })
  afterEach(() => {
    if (previousDirectory === undefined) delete process.env.ZY_CONFIG_DIR
    else process.env.ZY_CONFIG_DIR = previousDirectory
    rmSync(directory, { recursive: true, force: true })
  })
  test('没有手工条目时，目录能力落盘并通过原有能力入口生效', () => {
    expect(saveDiscoveredModelCapability(selection, capability).error).toBeNull()
    expect(getLocalModelInputModalities('new-model', context)).toEqual(['text', 'image'])
    expect(getLocalContextWindow('new-model', context)).toBe(1048576)
    expect(getLocalModelEffortLevels('new-model', context)).toEqual(['on'])
    expect(
      JSON.parse(
        readFileSync(
          join(directory, 'model-capabilities', 'discovered-model-capabilities.json'),
          'utf8',
        ),
      ).entries,
    ).toHaveLength(1)
  })
  test('手工配置明确值优先，目录补齐遗漏字段而且不修改手工文件', () => {
    const manual = JSON.stringify({
      models: [
        {
          pattern: 'new-model',
          provider: 'generic',
          capabilities: { structured_outputs: false },
          tokens: { maxOutputTokens: 1000 },
        },
      ],
    })
    writeFileSync(join(directory, 'model-capabilities.json'), manual)
    expect(saveDiscoveredModelCapability(selection, capability).error).toBeNull()
    const entry = getLocalModelCapability('new-model', context)
    expect(entry?.capabilities.input).toEqual(['text', 'image'])
    expect(entry?.capabilities.thinking?.effort).toEqual(['on'])
    expect(entry?.capabilities.structured_outputs).toBe(false)
    expect(entry?.tokens).toEqual({ contextWindow: 1048576, maxOutputTokens: 1000 })
    expect(readFileSync(join(directory, 'model-capabilities.json'), 'utf8')).toBe(manual)
  })
  test('明确关闭思考不能被目录的思考声明覆盖', () => {
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({
        models: [{ pattern: 'new-model', capabilities: { thinking: { effort: ['off'] } } }],
      }),
    )
    saveDiscoveredModelCapability(selection, capability)
    expect(getLocalModelEffortLevels('new-model', context)).toEqual(['off'])
  })
  test('相同名称按连接、协议和完整 ID 隔离', () => {
    saveDiscoveredModelCapability(selection, capability)
    expect(
      getLocalModelCapability('new-model', { ...context, connectionId: 'other' }),
    ).toBeUndefined()
    expect(
      getLocalModelCapability('new-model', { ...context, apiFormat: 'anthropic' }),
    ).toBeUndefined()
    expect(getLocalModelCapability('new-model-next', context)).toBeUndefined()
    expect(
      getLocalModelCapability('new-model', { ...context, provider: 'openrouter' }),
    ).toBeUndefined()
  })
  test('刷新同一个模型更新元数据，不复制旧字段或重复条目', () => {
    saveDiscoveredModelCapability(selection, capability)
    saveDiscoveredModelCapability(selection, {
      capabilities: { input: ['text'] },
      tokens: { contextWindow: 32000 },
    })
    expect(getLocalModelCapability('new-model', context)?.capabilities.thinking).toBeUndefined()
    expect(getLocalModelInputModalities('new-model', context)).toEqual(['text'])
    expect(getLocalContextWindow('new-model', context)).toBe(32000)
    expect(
      JSON.parse(
        readFileSync(
          join(directory, 'model-capabilities', 'discovered-model-capabilities.json'),
          'utf8',
        ),
      ).entries,
    ).toHaveLength(1)
  })
  test('损坏的自动文件不影响手工能力，保存失败不覆盖原文件', () => {
    writeFileSync(
      join(directory, 'model-capabilities', 'discovered-model-capabilities.json'),
      '{ broken',
    )
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({ models: [{ pattern: 'new-model', capabilities: { input: ['text'] } }] }),
    )
    expect(getLocalModelInputModalities('new-model', context)).toEqual(['text'])
    expect(saveDiscoveredModelCapability(selection, capability).error).toBeInstanceOf(Error)
    expect(
      readFileSync(
        join(directory, 'model-capabilities', 'discovered-model-capabilities.json'),
        'utf8',
      ),
    ).toBe('{ broken')
  })
  test('未声明思考保持未知，旧布尔声明保留真实支持语义', () => {
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({
        models: [
          { pattern: 'unknown', capabilities: {} },
          { pattern: 'enabled', capabilities: { thinking: true } },
          { pattern: 'disabled', capabilities: { thinking: false } },
        ],
      }),
    )
    expect(getLocalModelEffortLevels('unknown', context)).toBeUndefined()
    expect(getLocalModelEffortLevels('enabled', context)).toEqual(['on'])
    expect(getLocalModelEffortLevels('disabled', context)).toEqual(['off'])
  })

  test('连接级界面覆盖高于手工文件，自动刷新不覆盖用户修改或写入额外连接字段', () => {
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({
        models: [{ pattern: 'new-model', capabilities: { thinking: { effort: ['on'] } } }],
      }),
    )
    const connectionOptions = { ...selection, apiKey: 'fixture-secret' }
    saveDiscoveredModelCapability(connectionOptions, capability)
    saveDiscoveredModelCapability(
      selection,
      { capabilities: { thinking: { effort: ['off'] } } },
      'user',
    )
    saveDiscoveredModelCapability(
      selection,
      { ...capability, tokens: { contextWindow: 200000 } },
      'registry',
    )
    expect(getLocalModelEffortLevels('new-model', context)).toEqual(['off'])
    expect(getLocalContextWindow('new-model', context)).toBe(200000)
    expect(
      readFileSync(
        join(directory, 'model-capabilities', 'discovered-model-capabilities.json'),
        'utf8',
      ),
    ).not.toContain('fixture-secret')
    saveDiscoveredModelCapability(selection, { capabilities: {} }, 'user')
    expect(getLocalModelEffortLevels('new-model', context)).toEqual(['on'])
  })
  test('用户关闭思考落盘后不继承手工 preserve/adaptive，恢复未知后重新继承', () => {
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'new-model',
            capabilities: { thinking: { preserve: 'optional', adaptive: true, effort: ['on'] } },
          },
        ],
      }),
    )
    const off = { capabilities: { thinking: { effort: { levels: ['off' as const] } } } }
    expect(saveDiscoveredModelCapability(selection, off, 'user').error).toBeNull()
    expect(getLocalModelEffortLevels('new-model', context)).toEqual(['off'])
    expect(localModelHasCapability('new-model', 'thinking', context)).toBe(false)
    expect(getLocalModelPreserveThinking('new-model', context)).toBeUndefined()
    expect(localModelHasAdaptiveThinking('new-model', context)).toBe(false)
    saveDiscoveredModelCapability(selection, { capabilities: {} }, 'user')
    expect(getLocalModelPreserveThinking('new-model', context)).toBe('optional')
  })
})
