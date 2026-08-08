import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getLocalContextWindow,
  getLocalModelApiFormat,
  getLocalModelCapability,
  getLocalModelCosts,
  localModelHasCapability,
} from '../../src/services/settings/localModelCapabilities.js'

let previousConfigDir: string | undefined
let configDir: string

beforeEach(() => {
  previousConfigDir = process.env.ZY_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'zy-model-capabilities-'))
  process.env.ZY_CONFIG_DIR = configDir
  writeFileSync(
    join(configDir, 'model-capabilities.json'),
    JSON.stringify({
      models: [
        {
          pattern: 'shared-model',
          capabilities: {
            thinking: { effort: ['off'] },
            structured_outputs: false,
          },
          tokens: { contextWindow: '128k' },
          costs: { currency: 'USD', inputTokens: 1, outputTokens: 2 },
          providerOverrides: {
            'opencode-go': {
              apiFormat: 'openai-chat',
              capabilities: {
                structured_outputs: true,
              },
              tokens: { contextWindow: '512k' },
              costs: {
                currency: 'USD',
                inputTokens: 0.95,
                outputTokens: 4,
                promptCacheReadTokens: 0.19,
              },
            },
          },
        },
        {
          pattern: 'shared-model',
          provider: 'openrouter',
          apiFormat: 'openai-chat',
          capabilities: {
            thinking: { effort: ['off', 'balanced'] },
            structured_outputs: true,
          },
          tokens: { contextWindow: '1m' },
          costs: { currency: 'USD', inputTokens: 3, outputTokens: 6 },
        },
        {
          pattern: 'shared-model',
          provider: 'gemini',
          apiFormat: 'google',
          capabilities: {
            thinking: { effort: ['off'] },
            structured_outputs: true,
          },
          tokens: { contextWindow: '2m' },
          costs: { currency: 'USD', inputTokens: 0.5, outputTokens: 1.5 },
        },
        {
          pattern: 'grok-4.1-fast-reasoning',
          capabilities: {
            thinking: { preserve: 'always', effort: ['off', 'on'] },
            structured_outputs: true,
          },
          tokens: { contextWindow: '2m' },
          costs: {
            currency: 'USD',
            inputTokens: 0.2,
            outputTokens: 0.5,
            promptCacheReadTokens: 0.05,
          },
          providerOverrides: {
            'opencode-go': {
              costs: {
                currency: 'USD',
                inputTokens: 0.1,
                outputTokens: 0.3,
                promptCacheReadTokens: 0.025,
              },
            },
          },
        },
      ],
    }),
  )
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.ZY_CONFIG_DIR
  } else {
    process.env.ZY_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('localModelCapabilities', () => {
  test('同名模型按 provider 和 apiFormat 选择不同能力条目', () => {
    expect(
      getLocalContextWindow('vendor/shared-model', {
        provider: 'anthropic',
        apiFormat: 'anthropic',
      }),
    ).toBe(128 * 1024)
    expect(
      getLocalContextWindow('vendor/shared-model', {
        provider: 'openrouter',
        apiFormat: 'openai-chat',
      }),
    ).toBe(1_000_000)
    expect(
      getLocalContextWindow('vendor/shared-model', {
        provider: 'gemini',
        apiFormat: 'google',
      }),
    ).toBe(2_000_000)
  })

  test('provider 专属条目的 cost 和能力不会污染其他 provider', () => {
    expect(
      localModelHasCapability('vendor/shared-model', 'structured_outputs', {
        provider: 'anthropic',
        apiFormat: 'anthropic',
      }),
    ).toBe(false)
    expect(
      localModelHasCapability('vendor/shared-model', 'structured_outputs', {
        provider: 'openrouter',
        apiFormat: 'openai-chat',
      }),
    ).toBe(true)
    expect(
      getLocalModelCosts('vendor/shared-model', 1000, {
        provider: 'openrouter',
        apiFormat: 'openai-chat',
      })?.inputTokens,
    ).toBe(3)
  })

  test('Grok 模型在 opencode-go 下覆盖价格并保留上下文窗口', () => {
    expect(getLocalContextWindow('xai/grok-4.1-fast-reasoning')).toBe(2_000_000)
    expect(
      getLocalModelCosts('xai/grok-4.1-fast-reasoning', 1000, {
        provider: 'xai',
        apiFormat: 'openai-chat',
      }),
    ).toMatchObject({ inputTokens: 0.2, outputTokens: 0.5 })
    expect(
      getLocalModelCosts('xai/grok-4.1-fast-reasoning', 1000, {
        provider: 'opencode-go',
        apiFormat: 'openai-chat',
      }),
    ).toMatchObject({ inputTokens: 0.1, outputTokens: 0.3, promptCacheReadTokens: 0.025 })
  })

  test('模型级 apiFormat 可在不知道当前 apiFormat 时按 provider 读取', () => {
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'openrouter' })).toBe(
      'openai-chat',
    )
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'gemini' })).toBe('google')
    expect(
      getLocalModelCapability('vendor/shared-model', { provider: 'openrouter' })?.pattern,
    ).toBe('shared-model')
  })

  test('providerOverrides 可覆盖同一模型在不同 provider 下的上下文和价格', () => {
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'opencode-go' })).toBe(
      'openai-chat',
    )
    expect(
      getLocalContextWindow('vendor/shared-model', {
        provider: 'opencode-go',
        apiFormat: 'openai-chat',
      }),
    ).toBe(512 * 1024)
    expect(
      getLocalModelCosts('vendor/shared-model', 1000, {
        provider: 'opencode-go',
        apiFormat: 'openai-chat',
      }),
    ).toMatchObject({
      currency: 'USD',
      inputTokens: 0.95,
      outputTokens: 4,
      promptCacheReadTokens: 0.19,
    })
    expect(
      localModelHasCapability('vendor/shared-model', 'structured_outputs', {
        provider: 'opencode-go',
        apiFormat: 'openai-chat',
      }),
    ).toBe(true)
  })
})

describe('多文件分片加载', () => {
  /** 建好分片目录（存在性由调用方保证）。 */
  function fragDir(): string {
    const dir = join(configDir, 'model-capabilities')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('目录分片按名称字典序合并加载', () => {
    const dir = fragDir()
    writeFileSync(
      join(dir, 'z-late.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'frag-z',
            capabilities: { thinking: { effort: ['off', 'on'] } },
            tokens: { contextWindow: '64k' },
          },
        ],
      }),
    )
    writeFileSync(
      join(dir, 'a-early.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'frag-a',
            capabilities: { thinking: { effort: ['off'] } },
            tokens: { contextWindow: '32k' },
          },
        ],
      }),
    )
    expect(getLocalContextWindow('frag-a')).toBe(32 * 1024)
    expect(getLocalContextWindow('frag-z')).toBe(64 * 1024)
  })

  test('主文件与目录分片共存时主文件条目优先（完全同特异性）', () => {
    // beforeEach 的主文件已含 shared-model（全局条目，128k）；
    // 目录分片写入完全相同的 pattern（无 provider/apiFormat 选择器），
    // 特异性（选择器 + pattern 长度）完全一致时，先加载的主文件条目赢
    const dir = fragDir()
    writeFileSync(
      join(dir, 'zz-override.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'shared-model',
            capabilities: { thinking: { effort: ['off'] } },
            tokens: { contextWindow: '64k' },
          },
        ],
      }),
    )
    expect(
      getLocalContextWindow('shared-model', {
        provider: 'anthropic',
        apiFormat: 'anthropic',
      }),
    ).toBe(128 * 1024)
  })

  test('JSONC 注释、尾逗号与字符串内 URL 正常解析', () => {
    const dir = fragDir()
    writeFileSync(
      join(dir, 'commented.jsonc'),
      `{
        // 模型能力分片支持注释
        "models": [
          {
            "pattern": "commented-model",
            /* 块注释 */
            "capabilities": {
              "thinking": {
                "effort": {
                  "levels": ["off", "on"],
                  // 字符串值里的 // 不应被当作注释剥离
                  "map": { "on": "https://api.example.com/high" }
                }
              }
            },
            "tokens": { "contextWindow": "48k" },
          },
        ],
      }`,
    )
    expect(
      localModelHasCapability('commented-model', 'thinking', {
        provider: 'generic',
        apiFormat: 'openai-chat',
      }),
    ).toBe(true)
    expect(getLocalContextWindow('commented-model')).toBe(48 * 1024)
    // effort.map 的 URL 值完整保留（未被注释剥离器误伤）
    const entry = getLocalModelCapability('commented-model', {
      provider: 'generic',
      apiFormat: 'openai-chat',
    })
    const map = entry?.capabilities.thinking?.effort as { map?: Record<string, string> } | undefined
    expect(map?.map?.on).toBe('https://api.example.com/high')
  })

  test('单个坏分片不影响其他文件加载', () => {
    const dir = fragDir()
    writeFileSync(join(dir, 'bad.json'), '{ 这不是合法 JSON')
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'good-frag',
            capabilities: { thinking: { effort: ['off'] } },
            tokens: { contextWindow: '16k' },
          },
        ],
      }),
    )
    expect(getLocalContextWindow('good-frag')).toBe(16 * 1024)
  })

  test('主文件不存在时仅用目录分片', () => {
    // 覆盖 beforeEach 的主文件：先删掉再建分片
    rmSync(join(configDir, 'model-capabilities.json'), { force: true })
    const dir = fragDir()
    writeFileSync(
      join(dir, 'only.json'),
      JSON.stringify({
        models: [
          {
            pattern: 'only-frag',
            capabilities: { thinking: { effort: ['off'] } },
            tokens: { contextWindow: '8k' },
          },
        ],
      }),
    )
    expect(getLocalContextWindow('only-frag')).toBe(8 * 1024)
  })
})
