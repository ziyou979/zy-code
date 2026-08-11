import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAuthProfileForModelFromSettings,
  getModelCandidatesForTier,
  normalizeModelTierValue,
  pinModelCandidate,
  selectActiveCandidate,
} from '../../../src/services/model/model.js'
import {
  clearAllModelChainSticky,
  setStickyForTier,
} from '../../../src/services/model/modelChainState.js'
import {
  classifyAuthChainSwitchableError,
  clearAuthChainFailureCounts,
  tryAdvanceAuthChainOnError,
} from '../../../src/services/model/modelChainFailover.js'
import type { SettingsJson } from '../../../src/services/settings/types.js'
import { CannotRetryError } from '../../../src/services/api/withRetry.js'
import { LLMError } from '../../../src/types/llm.js'
import { getProviderForModelFromSettings } from '../../../src/services/model/model.js'

describe('model candidates / multi-auth', () => {
  let configDir: string
  let prevConfigDir: string | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-model-chain-'))
    prevConfigDir = process.env.ZY_CONFIG_DIR
    process.env.ZY_CONFIG_DIR = configDir
    clearAuthChainFailureCounts()
    clearAllModelChainSticky(null)
  })

  afterEach(() => {
    clearAuthChainFailureCounts()
    if (prevConfigDir === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = prevConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('normalizeModelTierValue 兼容字符串与对象', () => {
    expect(normalizeModelTierValue('m1', 'dashscope')).toEqual([
      { model: 'm1', provider: 'dashscope', candidateIndex: 0 },
    ])
    expect(normalizeModelTierValue({ provider: 'xai', model: 'grok-4.3' }, 'generic')).toEqual([
      { model: 'grok-4.3', provider: 'xai', candidateIndex: 0 },
    ])
  })

  test('normalizeModelTierValue 保留数组顺序', () => {
    const list = normalizeModelTierValue(
      [
        { provider: 'xai', model: 'grok-4.3' },
        { provider: 'dashscope', model: 'qwen3.6-plus' },
      ],
      'generic',
    )
    expect(list.map((c) => c.model)).toEqual(['grok-4.3', 'qwen3.6-plus'])
    expect(list[0]?.provider).toBe('xai')
    expect(list[1]?.provider).toBe('dashscope')
  })

  test('provider 可引用 auth.json 中的多个 generic 命名连接', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'generic-primary': { provider: 'generic', baseUrl: 'https://one.example/v1' },
        'generic-backup': { provider: 'generic', baseUrl: 'https://two.example/v1' },
      }),
    )
    const list = normalizeModelTierValue([
      { provider: 'generic-primary', model: 'model-a' },
      { provider: 'generic-backup', model: 'model-b' },
    ])

    expect(list.map((candidate) => candidate.provider)).toEqual(['generic', 'generic'])
    expect(list.map((candidate) => candidate.authProfile)).toEqual([
      'generic-primary',
      'generic-backup',
    ])
  })

  test('相同模型使用 sticky 区分不同 generic 连接', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'generic-primary': { provider: 'generic', baseUrl: 'https://one.example/v1' },
        'generic-backup': { provider: 'generic', baseUrl: 'https://two.example/v1' },
      }),
    )
    const settings: SettingsJson = {
      provider: 'generic',
      models: {
        standard: [
          { provider: 'generic-primary', model: 'shared-model' },
          { provider: 'generic-backup', model: 'shared-model' },
        ],
      },
    }
    const candidates = getModelCandidatesForTier('standard', settings, 'generic')
    pinModelCandidate('standard', candidates[1]!, settings)

    expect(getAuthProfileForModelFromSettings(settings, 'shared-model', 'generic')).toBe(
      'generic-backup',
    )
  })

  test('getModelCandidatesForTier 读取顶层数组', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      models: {
        standard: [
          { provider: 'xai', model: 'grok-4.3' },
          { provider: 'dashscope', model: 'qwen3.6-plus' },
        ],
      },
    }
    const candidates = getModelCandidatesForTier('standard', settings, 'generic')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.model).toBe('grok-4.3')
  })

  test('selectActiveCandidate 默认取 index 0，sticky 后取粘住项', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      mainLoopModel: 'standard',
      models: {
        standard: [
          { provider: 'xai', model: 'grok-4.3' },
          { provider: 'dashscope', model: 'qwen3.6-plus' },
        ],
      },
    }
    const candidates = getModelCandidatesForTier('standard', settings, 'generic')
    expect(selectActiveCandidate(candidates, 'standard', settings)?.model).toBe('grok-4.3')

    setStickyForTier(
      'standard',
      { index: 1, provider: 'dashscope', model: 'qwen3.6-plus', reason: 'auth_failed' },
      settings,
    )
    expect(selectActiveCandidate(candidates, 'standard', settings)?.model).toBe('qwen3.6-plus')
    expect(getProviderForModelFromSettings(settings, 'qwen3.6-plus', 'generic')).toBe('dashscope')
  })

  test('pinModelCandidate 允许 /model 主动切换到备选 provider', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      models: {
        standard: [
          { provider: 'xai', model: 'grok-4.5' },
          { provider: 'deepseek', model: 'deepseek-v4-flash' },
        ],
      },
    }
    const candidates = getModelCandidatesForTier('standard', settings, 'generic')

    pinModelCandidate('standard', candidates[1]!, settings)

    const selected = selectActiveCandidate(candidates, 'standard', settings)
    expect(selected?.model).toBe('deepseek-v4-flash')
    expect(selected?.provider).toBe('deepseek')
    expect(selected?.candidateIndex).toBe(1)
    expect(getProviderForModelFromSettings(settings, null, 'generic')).toBe('deepseek')
  })

  test('classifyAuthChainSwitchableError 识别 401/429，忽略 529', () => {
    expect(classifyAuthChainSwitchableError(new LLMError('nope', 401))).toBe('auth_failed')
    expect(classifyAuthChainSwitchableError(new LLMError('slow', 429))).toBe('rate_limit_exhausted')
    expect(classifyAuthChainSwitchableError(new LLMError('overload', 529))).toBeNull()

    const wrapped = new CannotRetryError(new LLMError('x', 401), {
      model: 'm',
      thinkingConfig: { type: 'disabled' },
    })
    expect(classifyAuthChainSwitchableError(wrapped)).toBe('auth_failed')
  })

  test('tryAdvanceAuthChainOnError 达到阈值后推进', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      mainLoopModel: 'standard',
      models: {
        standard: [
          { provider: 'xai', model: 'grok-a' },
          { provider: 'dashscope', model: 'qwen-b' },
        ],
      },
      modelFailover: { enabled: true, maxConsecutiveFailures: 2 },
    }

    const err = new CannotRetryError(new LLMError('bad key', 401), {
      model: 'grok-a',
      thinkingConfig: { type: 'disabled' },
    })

    // 第 1 次未达阈值
    expect(tryAdvanceAuthChainOnError('grok-a', err, settings)).toBeNull()
    // 第 2 次推进
    const advanced = tryAdvanceAuthChainOnError('grok-a', err, settings)
    expect(advanced?.next.model).toBe('qwen-b')
    expect(advanced?.reason).toBe('auth_failed')
    expect(advanced?.toIndex).toBe(1)
  })
})
