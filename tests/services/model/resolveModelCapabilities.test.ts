import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findRegistryModel,
  resolveModelCapabilities,
} from '../../../src/services/model/resolveModelCapabilities.js'
import { saveDiscoveredModelCapability } from '../../../src/services/settings/discoveredModelCapabilities.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../../src/bootstrap/runtime/runtimeContext.js'

describe('resolveModelCapabilities', () => {
  let directory: string
  let previousDirectory: string | undefined
  let previousSources: ReturnType<typeof getAllowedSettingSources>
  const originalFetch = globalThis.fetch
  const options = {
    provider: 'openai',
    connectionId: 'personal',
    apiFormat: 'openai-chat' as const,
    apiKey: 'fixture-secret',
  }
  const registryModel = {
    id: 'new-model',
    reasoning: true,
    structured_output: true,
    modalities: { input: ['text', 'image', 'pdf'] },
    limit: { context: 128000, output: 8000 },
  }
  beforeEach(() => {
    previousDirectory = process.env.ZY_CONFIG_DIR
    previousSources = getAllowedSettingSources()
    directory = mkdtempSync(join(tmpdir(), 'zy-resolve-capabilities-'))
    process.env.ZY_CONFIG_DIR = directory
    mkdirSync(join(directory, 'model-capabilities'))
    setAllowedSettingSources(['userSettings'])
    resetSettingsCache()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    setAllowedSettingSources(previousSources)
    if (previousDirectory === undefined) delete process.env.ZY_CONFIG_DIR
    else process.env.ZY_CONFIG_DIR = previousDirectory
    resetSettingsCache()
    rmSync(directory, { recursive: true, force: true })
  })
  test('只有模型 ID 时自动补齐动态能力，公共查询不携带连接密钥', async () => {
    let authorized = false
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      authorized = new Headers(init?.headers).has('Authorization')
      return new Response(JSON.stringify({ openai: { models: { 'new-model': registryModel } } }))
    }) as unknown as typeof fetch
    const result = await resolveModelCapabilities({ id: 'new-model' }, options)
    expect(result.source).toBe('registry')
    expect(result.effective.capabilities.input).toEqual(['text', 'image', 'application/pdf'])
    expect(result.effective.capabilities.thinking?.effort).toEqual(['on'])
    expect(result.effective.tokens).toEqual({ contextWindow: 128000, maxOutputTokens: 8000 })
    expect(authorized).toBe(false)
  })
  test('平台明确字段优先于公共目录，手工覆盖再覆盖自动结果', async () => {
    writeFileSync(
      join(directory, 'model-capabilities.json'),
      JSON.stringify({
        models: [{ pattern: 'new-model', capabilities: { structured_outputs: false } }],
      }),
    )
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ openai: { models: { 'new-model': registryModel } } })),
    ) as unknown as typeof fetch
    const result = await resolveModelCapabilities(
      {
        id: 'new-model',
        capability: { capabilities: { input: ['text'] }, tokens: { contextWindow: 32000 } },
      },
      options,
    )
    expect(result.effective.capabilities.input).toEqual(['text'])
    expect(result.effective.capabilities.structured_outputs).toBe(false)
    expect(result.effective.tokens?.contextWindow).toBe(32000)
    expect(result.effective.tokens?.maxOutputTokens).toBe(8000)
  })
  test('优先按完整端点区分订阅计划，未知端点回退到相同模型 ID', () => {
    const data = {
      volcengine: {
        api: 'https://ark.example/api/v3',
        models: { 'new-model': { id: 'new-model', reasoning: true } },
      },
      'volcengine-coding-plan': {
        api: 'https://ark.example/api/coding/v3',
        models: { 'new-model': { id: 'new-model', reasoning: false } },
      },
    }
    expect(
      findRegistryModel(
        data,
        { provider: 'ark', baseUrl: 'https://ark.example/api/coding/v3/' },
        'new-model',
      )?.reasoning,
    ).toBe(false)
    expect(
      findRegistryModel(
        data,
        { provider: 'generic', baseUrl: 'https://private.example/v1' },
        'new-model',
      )?.reasoning,
    ).toBe(true)
    expect(findRegistryModel(data, { provider: 'ark' }, 'new-model-next')).toBeUndefined()
  })
  test('平台不存在或缺少模型时按目录顺序取首个精确匹配，跳过不一致的 ID', () => {
    const first = { id: 'claude-sonnet-5-5', reasoning: true }
    const data = {
      invalid: { models: { 'claude-sonnet-5-5': { id: 'another-model' } } },
      anthropic: { models: { 'claude-sonnet-5-5': first } },
      other: { models: { 'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', reasoning: false } } },
      empty: { api: 'https://private.example/v1', models: {} },
    }
    expect(findRegistryModel(data, { provider: 'generic' }, 'claude-sonnet-5-5')).toBe(first)
    expect(
      findRegistryModel(
        data,
        { provider: 'empty', baseUrl: 'https://private.example/v1' },
        'claude-sonnet-5-5',
      ),
    ).toBe(first)
    expect(findRegistryModel(data, { provider: 'other' }, 'claude-sonnet-5-5')?.reasoning).toBe(
      false,
    )
    expect(findRegistryModel(data, { provider: 'generic' }, 'claude-sonnet-5.5')).toBeUndefined()
    expect(findRegistryModel(null, { provider: 'generic' }, 'claude-sonnet-5-5')).toBeUndefined()
  })
  test('跨平台默认能力仍可被平台元数据和用户覆盖逐字段修改', async () => {
    const customOptions = {
      ...options,
      provider: 'generic',
      baseUrl: 'https://private.example/v1',
    }
    saveDiscoveredModelCapability(
      { ...customOptions, model: 'new-model' },
      { capabilities: { thinking: { effort: ['off'] } } },
      'user',
    )
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ anthropic: { models: { 'new-model': registryModel } } })),
    ) as unknown as typeof fetch
    const result = await resolveModelCapabilities(
      { id: 'new-model', capability: { capabilities: { input: ['text'] } } },
      customOptions,
    )
    expect(result.automatic?.capabilities.thinking?.effort).toEqual(['on'])
    expect(result.effective.capabilities.input).toEqual(['text'])
    expect(result.effective.capabilities.thinking?.effort).toEqual(['off'])
    expect(result.effective.tokens).toEqual({ contextWindow: 128000, maxOutputTokens: 8000 })
  })
  test('完整平台数据不查询公共服务，离线和禁用查询不阻止使用未知模型', async () => {
    const request = mock(async () => {
      throw new DOMException('timeout', 'TimeoutError')
    })
    globalThis.fetch = request as unknown as typeof fetch
    const complete = await resolveModelCapabilities(
      {
        id: 'new-model',
        capability: {
          capabilities: {
            input: ['text'],
            thinking: { effort: ['off'] },
            structured_outputs: false,
          },
          tokens: { contextWindow: 32000, maxOutputTokens: 4000 },
        },
      },
      options,
    )
    expect(complete.source).toBe('catalog')
    expect(request).not.toHaveBeenCalled()
    const timedOut = await resolveModelCapabilities({ id: 'unknown' }, options)
    expect(timedOut.source).toBe('unknown')
    expect(timedOut.catalogIssue).toBe('timeout')
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({ modelCapabilityCatalogUrl: null }),
    )
    resetSettingsCache()
    request.mockClear()
    expect(
      (await resolveModelCapabilities({ id: 'unknown' }, options)).effective.capabilities,
    ).toEqual({})
    expect(request).not.toHaveBeenCalled()
  })
  test('目录网络失败和模型未收录分别报告原因，取消查询不提示失败', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect((await resolveModelCapabilities({ id: 'unknown' }, options)).catalogIssue).toBe(
      'unavailable',
    )
    const controller = new AbortController()
    controller.abort()
    expect(
      (await resolveModelCapabilities({ id: 'unknown' }, { ...options, signal: controller.signal }))
        .catalogIssue,
    ).toBeUndefined()
    globalThis.fetch = mock(async () => new Response('{}')) as unknown as typeof fetch
    expect((await resolveModelCapabilities({ id: 'unknown' }, options)).catalogIssue).toBe(
      'not-found',
    )
    globalThis.fetch = mock(
      async () => new Response('', { status: 503 }),
    ) as unknown as typeof fetch
    expect((await resolveModelCapabilities({ id: 'unknown' }, options)).catalogIssue).toBe(
      'unavailable',
    )
  })
  test('已缓存的完整能力可离线复用，刷新会重新查询且保留用户覆盖', async () => {
    saveDiscoveredModelCapability(
      { ...options, model: 'new-model' },
      {
        capabilities: { input: ['text'], thinking: { effort: ['on'] }, structured_outputs: true },
        tokens: { contextWindow: 32000, maxOutputTokens: 4000 },
      },
      'registry',
    )
    saveDiscoveredModelCapability(
      { ...options, model: 'new-model' },
      { capabilities: { thinking: { effort: ['off'] } } },
      'user',
    )
    const request = mock(
      async () =>
        new Response(JSON.stringify({ openai: { models: { 'new-model': registryModel } } })),
    )
    globalThis.fetch = request as unknown as typeof fetch
    expect(
      (await resolveModelCapabilities({ id: 'new-model' }, options)).effective.tokens
        ?.contextWindow,
    ).toBe(32000)
    expect(request).not.toHaveBeenCalled()
    const refreshed = await resolveModelCapabilities(
      { id: 'new-model' },
      { ...options, refresh: true },
    )
    expect(refreshed.effective.tokens?.contextWindow).toBe(128000)
    expect(refreshed.effective.capabilities.thinking?.effort).toEqual(['off'])
    expect(request).toHaveBeenCalledTimes(1)
  })
})
