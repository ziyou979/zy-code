import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getLocalContextWindow,
  getLocalModelApiFormat,
  getLocalModelCapability,
  getLocalModelCosts,
  localModelHasCapability,
} from '../../src/services/settings/localModelCapabilities.js'

describe('localModelCapabilities', () => {
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
                apiFormat: 'openai',
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
            apiFormat: 'openai',
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
        apiFormat: 'openai',
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
        apiFormat: 'openai',
      }),
    ).toBe(true)
    expect(
      getLocalModelCosts('vendor/shared-model', 1000, {
        provider: 'openrouter',
        apiFormat: 'openai',
      })?.inputTokens,
    ).toBe(3)
  })

  test('模型级 apiFormat 可在不知道当前 apiFormat 时按 provider 读取', () => {
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'openrouter' })).toBe('openai')
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'gemini' })).toBe('google')
    expect(
      getLocalModelCapability('vendor/shared-model', { provider: 'openrouter' })?.pattern,
    ).toBe('shared-model')
  })

  test('providerOverrides 可覆盖同一模型在不同 provider 下的上下文和价格', () => {
    expect(getLocalModelApiFormat('vendor/shared-model', { provider: 'opencode-go' })).toBe(
      'openai',
    )
    expect(
      getLocalContextWindow('vendor/shared-model', {
        provider: 'opencode-go',
        apiFormat: 'openai',
      }),
    ).toBe(512 * 1024)
    expect(
      getLocalModelCosts('vendor/shared-model', 1000, {
        provider: 'opencode-go',
        apiFormat: 'openai',
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
        apiFormat: 'openai',
      }),
    ).toBe(true)
  })
})
