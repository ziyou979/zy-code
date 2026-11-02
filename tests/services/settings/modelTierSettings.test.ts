import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  getMainLoopModelOverride,
  setAllowedSettingSources,
  setMainLoopModelOverride,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import {
  getAuthProfileForModel,
  getMainLoopModel,
  getProviderForModel,
} from '../../../src/services/model/model.js'
import {
  addModelTierCandidate,
  clearModelTierFallbacks,
  getModelTierCandidates,
  getModelTierProviderConnections,
  removeModelTierCandidate,
  reorderModelTierCandidates,
  saveMainLoopModelSetting,
  saveModelFailoverPolicy,
  saveModelTierSelection,
  ShadowedModelTierError,
} from '../../../src/services/settings/modelTierSettings.js'
import {
  createTierCandidateOptions,
  applyModelOptionSelection,
} from '../../../src/services/model/modelOptions.js'
import { getModelCandidatesForTier, pinModelCandidate } from '../../../src/services/model/model.js'
import { getStickyForTier, setStickyForTier } from '../../../src/services/model/modelChainState.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../../src/services/settings/settings.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'
import { saveDiscoveredModelCapability } from '../../../src/services/settings/discoveredModelCapabilities.js'
import type { SettingsJson } from '../../../src/services/settings/types.js'
import { type AppState, getDefaultAppState } from '../../../src/state/AppStateStore.js'
import { onChangeAppState } from '../../../src/state/onChangeAppState.js'
import { createStore } from '../../../src/state/store.js'

describe('modelTierSettings', () => {
  let configDir: string
  let previousConfigDir: string | undefined
  let previousSources: ReturnType<typeof getAllowedSettingSources>
  let previousOverride: ReturnType<typeof getMainLoopModelOverride>
  const oldStandard = [
    { provider: 'stepfun', model: 'old-model' },
    { provider: 'deepseek', model: 'backup-model' },
  ]
  const advanced = [{ provider: 'deepseek', model: 'advanced-model' }]

  function readSaved(): SettingsJson {
    return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-tier-settings-'))
    previousConfigDir = process.env.ZY_CONFIG_DIR
    previousSources = getAllowedSettingSources()
    previousOverride = getMainLoopModelOverride()
    process.env.ZY_CONFIG_DIR = configDir
    setAllowedSettingSources(['userSettings'])
    setMainLoopModelOverride('old-model')
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        mainLoopModel: 'standard',
        model: 'old-model',
        models: { standard: oldStandard, advanced },
        language: 'en',
      }),
    )
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({ 'ling-personal': { provider: 'ant-ling', apiKey: 'fixture-key' } }),
    )
    resetSettingsCache()
  })

  afterEach(() => {
    setAllowedSettingSources(previousSources)
    setMainLoopModelOverride(previousOverride)
    if (previousConfigDir === undefined) delete process.env.ZY_CONFIG_DIR
    else process.env.ZY_CONFIG_DIR = previousConfigDir
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  })

  test('旧候选数组替换选中的模型时，更新主选并保留后续降级备选节点，落盘、会话及重启解析均生效', () => {
    const store = createStore<AppState>(
      { ...getDefaultAppState(), mainLoopModel: 'standard', mainLoopModelForSession: 'old-model' },
      onChangeAppState,
    )
    const result = saveModelTierSelection(
      { tier: 'standard', provider: 'ling-personal', model: 'Ling-3.1-flash', activate: true },
      store.setState,
    )
    expect(result.error).toBeNull()
    const saved = readSaved()
    expect(saved.models?.standard).toEqual([
      { provider: 'ling-personal', model: 'Ling-3.1-flash' },
      { provider: 'deepseek', model: 'backup-model' },
    ])
    expect(saved.models?.advanced).toEqual(advanced)
    expect(saved.model).toBeUndefined()
    expect(saved.mainLoopModel).toBe('standard')
    expect(saved.language).toBe('en')
    expect(store.getState().settings.models?.standard).toEqual(saved.models?.standard)
    expect(store.getState().mainLoopModelForSession).toBeNull()
    expect(getMainLoopModelOverride()).toBe('standard')
    expect(getMainLoopModel()).toBe('Ling-3.1-flash')
    expect(getProviderForModel('standard')).toBe('ant-ling')
    expect(getAuthProfileForModel('standard')).toBe('ling-personal')

    // 模拟重新启动后没有会话覆盖，必须仍从持久化配置解析出新模型和连接。
    setMainLoopModelOverride(undefined)
    resetSettingsCache()
    expect(getMainLoopModel()).toBe('Ling-3.1-flash')
    expect(getProviderForModel('standard')).toBe('ant-ling')
  })

  test('档位配置优先列出订阅、隐藏平台和自定义命名连接', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        deviceId: 'host-metadata',
        'openai-chatgpt': {
          provider: 'openai',
          oauth: { provider: 'openai-chatgpt', access: 'a', refresh: 'r', expires: 1 },
        },
        'gemini-oauth': {
          oauth: { provider: 'gemini-oauth', access: 'g', refresh: 'r', expires: 1 },
        },
        'vertex-2': {
          provider: 'vertex',
          credentialType: 'google-adc',
          vertex: { project: 'p', location: 'global' },
        },
        'generic-primary': { provider: 'generic', apiKey: 'key' },
      }),
    )

    const options = getModelTierProviderConnections()
    expect(options.slice(0, 4)).toEqual([
      { id: 'gemini-oauth', provider: 'gemini-oauth', configured: true },
      { id: 'generic-primary', provider: 'generic', configured: true },
      { id: 'openai-chatgpt', provider: 'openai', configured: true },
      { id: 'vertex-2', provider: 'vertex', configured: true },
    ])
    expect(options.some((entry) => entry.id === 'deviceId')).toBe(false)
    expect(options.some((entry) => entry.id === 'anthropic' && !entry.configured)).toBe(true)
  })

  test('当前主循环切换到新档位时，状态回调不会把模型名写成无连接的覆盖', () => {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const result = saveModelTierSelection(
      { tier: 'standard', provider: 'ling-personal', model: 'Ling-3.1-flash', activate: true },
      store.setState,
    )
    expect(result.error).toBeNull()
    expect(store.getState().mainLoopModel).toBe('standard')
    expect(readSaved().model).toBeUndefined()
    expect(getMainLoopModel()).toBe('Ling-3.1-flash')
  })

  test('配置非活动档位也同步共享 settings，同时保留当前会话模型', () => {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    expect(
      saveModelTierSelection(
        { tier: 'advanced', provider: 'ling-personal', model: 'Ring-new-model', activate: false },
        store.setState,
      ).error,
    ).toBeNull()
    expect(store.getState().settings.models?.advanced).toEqual({
      provider: 'ling-personal',
      model: 'Ring-new-model',
    })
    expect(readSaved().models?.standard).toEqual(oldStandard)
    expect(store.getState().mainLoopModel).toBeNull()
    expect(getMainLoopModelOverride()).toBe('old-model')
  })

  test('跳过已配置的可选档位会真正删除旧配置', () => {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    expect(
      saveModelTierSelection(
        { tier: 'advanced', provider: 'ling-personal', model: '', activate: false },
        store.setState,
      ).error,
    ).toBeNull()
    expect(readSaved().models?.advanced).toBeUndefined()
    expect(getInitialSettings().models?.advanced).toBeUndefined()
    expect(store.getState().settings.models?.advanced).toBeUndefined()
    expect(readSaved().models?.standard).toEqual(oldStandard)
  })

  test('保存失败不能切换会话状态或覆盖损坏的文件', () => {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const previousState = store.getState()
    writeFileSync(join(configDir, 'settings.json'), '{ invalid json')
    resetSettingsCache()
    const result = saveModelTierSelection(
      { tier: 'standard', provider: 'ling-personal', model: 'Ling-3.1-flash', activate: true },
      store.setState,
    )
    expect(result.error).toBeInstanceOf(Error)
    expect(store.getState()).toBe(previousState)
    expect(getMainLoopModelOverride()).toBe('old-model')
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toBe('{ invalid json')
  })

  test('单模型、数组和字符串互相切换时写入完整的最终值', () => {
    const reference = { provider: 'ling-personal', model: 'Ling-3.1-flash' }
    for (const value of [reference, [reference], 'string-model', [reference], reference]) {
      expect(
        updateSettingsForSource('userSettings', { models: { standard: value } }).error,
      ).toBeNull()
      expect(readSaved().models?.standard).toEqual(value)
      expect(getInitialSettings().models?.standard).toEqual(value)
      expect(readSaved().models?.advanced).toEqual(advanced)
    }
  })

  test('/model 同档位选择候选后清除旧覆盖，保留候选链且重启仍选中该候选', () => {
    const candidates = getModelCandidatesForTier('standard')
    const options = createTierCandidateOptions(
      'standard',
      candidates,
      candidates[0]!,
      (model) => model,
    )
    const selected = applyModelOptionSelection(options[1]!)
    expect(selected).toBe('standard')
    expect(saveMainLoopModelSetting(selected).error).toBeNull()
    setMainLoopModelOverride(selected)
    expect(getMainLoopModel()).toBe('backup-model')
    expect(getProviderForModel(selected!)).toBe('deepseek')
    expect(readSaved().models?.standard).toEqual(oldStandard)
    expect(readSaved().model).toBeUndefined()
    setMainLoopModelOverride(undefined)
    resetSettingsCache()
    expect(getMainLoopModel()).toBe('backup-model')
  })

  describe('显式选择主选与已粘住的降级候选', () => {
    function readStickyTiers(): Record<string, { model: string }> {
      return JSON.parse(readFileSync(join(configDir, 'model-chain-state.json'), 'utf8')).tiers
    }

    beforeEach(() => {
      // standard 已失效切换并粘住 backup-model；advanced 也有独立选择
      pinModelCandidate('standard', getModelCandidatesForTier('standard')[1]!)
      pinModelCandidate('advanced', getModelCandidatesForTier('advanced')[0]!)
      setMainLoopModelOverride('standard')
      expect(getMainLoopModel()).toBe('backup-model')
    })

    test('登录后启用新主选清除该档位 sticky，保留降级链与其他档位且重启后仍生效', () => {
      const result = saveModelTierSelection({
        tier: 'standard',
        provider: 'ling-personal',
        model: 'Ling-3.1-flash',
        activate: true,
      })
      expect(result.error).toBeNull()
      expect(readSaved().models?.standard).toEqual([
        { provider: 'ling-personal', model: 'Ling-3.1-flash' },
        { provider: 'deepseek', model: 'backup-model' },
      ])
      expect(getMainLoopModel()).toBe('Ling-3.1-flash')
      expect(getProviderForModel('standard')).toBe('ant-ling')
      expect(getAuthProfileForModel('standard')).toBe('ling-personal')
      expect(readStickyTiers().standard).toBeUndefined()
      expect(readStickyTiers().advanced?.model).toBe('advanced-model')

      setMainLoopModelOverride(undefined)
      resetSettingsCache()
      expect(getMainLoopModel()).toBe('Ling-3.1-flash')
      expect(getProviderForModel('standard')).toBe('ant-ling')
    })

    test('非激活编辑保留仍有效的 sticky', () => {
      const result = saveModelTierSelection({
        tier: 'standard',
        provider: 'ling-personal',
        model: 'Ling-3.1-flash',
        activate: false,
      })
      expect(result.error).toBeNull()
      expect(readStickyTiers().standard?.model).toBe('backup-model')
      expect(getMainLoopModel()).toBe('backup-model')
      expect(getProviderForModel('standard')).toBe('deepseek')
    })

    test('激活其他档位不清除 standard 的 sticky', () => {
      const result = saveModelTierSelection({
        tier: 'advanced',
        provider: 'ling-personal',
        model: 'Ling-3.1-flash',
        activate: true,
      })
      expect(result.error).toBeNull()
      expect(readStickyTiers().advanced).toBeUndefined()
      expect(readStickyTiers().standard?.model).toBe('backup-model')
      setMainLoopModelOverride('standard')
      expect(getMainLoopModel()).toBe('backup-model')
    })

    test('设置写入失败时保留 sticky', () => {
      writeFileSync(join(configDir, 'settings.json'), '{ invalid json')
      resetSettingsCache()
      const result = saveModelTierSelection({
        tier: 'standard',
        provider: 'ling-personal',
        model: 'Ling-3.1-flash',
        activate: true,
      })
      expect(result.error).toBeInstanceOf(Error)
      expect(readStickyTiers().standard?.model).toBe('backup-model')
      expect(getMainLoopModelOverride()).toBe('standard')
    })
  })

  test('主循环保存保留 provider 级配置中的候选和其他字段', () => {
    updateSettingsForSource('userSettings', {
      provider: 'deepseek',
      providers: {
        deepseek: {
          model: 'old-model',
          models: { standard: oldStandard },
          baseUrl: 'https://fixture.example/v1',
        },
      },
    })
    expect(saveMainLoopModelSetting('standard').error).toBeNull()
    expect(readSaved().providers?.deepseek).toEqual({
      mainLoopModel: 'standard',
      models: { standard: oldStandard },
      baseUrl: 'https://fixture.example/v1',
    })
    expect(saveMainLoopModelSetting('custom-model').error).toBeNull()
    expect(readSaved().providers?.deepseek?.model).toBe('custom-model')
    expect(readSaved().providers?.deepseek?.mainLoopModel).toBeUndefined()
    expect(saveMainLoopModelSetting(null).error).toBeNull()
    expect(readSaved().providers?.deepseek?.model).toBeUndefined()
    expect(readSaved().providers?.deepseek?.models?.standard).toEqual(oldStandard)
  })

  describe('provider 级档位作用域', () => {
    const scoped = [
      { provider: 'deepseek', model: 'ds-a' },
      { provider: 'deepseek', model: 'ds-b' },
    ]

    beforeEach(() => {
      updateSettingsForSource('userSettings', {
        provider: 'deepseek',
        providers: {
          deepseek: {
            models: { standard: scoped },
            baseUrl: 'https://fixture.example/v1',
          },
        },
      })
    })

    test('明确激活新主模型会解除旧备用选择，重载后仍选中新主模型', () => {
      setMainLoopModelOverride(undefined)
      updateSettingsForSource('userSettings', { model: undefined })
      const before = getInitialSettings()
      setStickyForTier('standard', { index: 1, provider: 'deepseek', model: 'ds-b' }, before)
      setStickyForTier(
        'advanced',
        { index: 0, provider: 'deepseek', model: 'advanced-model' },
        before,
      )
      expect(getMainLoopModel()).toBe('ds-b')
      expect(
        saveModelTierSelection({
          tier: 'standard',
          provider: 'deepseek',
          model: 'ds-c',
          activate: true,
        }).error,
      ).toBeNull()
      setMainLoopModelOverride(undefined)
      resetSettingsCache()
      expect(getMainLoopModel()).toBe('ds-c')
      expect(getStickyForTier('standard', getInitialSettings())).toBeNull()
      expect(getStickyForTier('advanced', getInitialSettings())?.model).toBe('advanced-model')
      expect(getModelTierCandidates('standard').map((candidate) => candidate.model)).toEqual([
        'ds-c',
        'ds-b',
      ])
    })

    test('顶层隐式平台在追加备选后仍与运行时一致', () => {
      const settings = readSaved()
      const providerModels = settings.providers?.deepseek?.models
      if (!providerModels) {
        throw new Error('Missing provider fixture')
      }
      delete providerModels.standard
      settings.models = { ...settings.models, standard: 'deepseek-chat' }
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
      resetSettingsCache()
      expect(getModelTierCandidates('standard')).toEqual([
        { provider: 'deepseek', model: 'deepseek-chat' },
      ])
      expect(
        addModelTierCandidate('standard', { provider: 'openai', model: 'gpt-4o' }).error,
      ).toBeNull()
      expect(getModelCandidatesForTier('standard')[0]?.provider).toBe('deepseek')
    })

    test('编辑器保留未配置的命名连接，运行时仍解析其平台', () => {
      const raw = [
        { provider: 'missing-conn', model: 'm1' },
        { model: 'ds-i' },
        { provider: 'ling-personal', model: 'm2' },
      ]
      updateSettingsForSource('userSettings', {
        providers: { deepseek: { models: { standard: raw } } },
      })
      expect(reorderModelTierCandidates('standard', 2, 0).error).toBeNull()
      expect(readSaved().providers?.deepseek?.models?.standard).toEqual([
        raw[2],
        raw[0],
        { provider: 'deepseek', model: 'ds-i' },
      ])
      expect(getModelCandidatesForTier('standard').map((c) => [c.provider, c.authProfile])).toEqual(
        [
          ['ant-ling', 'ling-personal'],
          [undefined, undefined],
          ['deepseek', undefined],
        ],
      )
    })

    test('可选档位无自身配置时编辑器为空并写入自身，运行时回落 standard', () => {
      updateSettingsForSource('userSettings', { models: { advanced: undefined } })
      expect(getModelTierCandidates('advanced')).toEqual([])
      expect(getModelCandidatesForTier('advanced')[0]?.model).toBe('ds-a')
      expect(
        addModelTierCandidate('advanced', { provider: 'deepseek', model: 'a1' }).error,
      ).toBeNull()
      expect(readSaved().providers?.deepseek?.models).toEqual({
        standard: scoped,
        advanced: { provider: 'deepseek', model: 'a1' },
      })
    })

    test('拒绝清空时返回可识别的遮蔽错误', () => {
      expect(removeModelTierCandidate('standard', 0).error).toBeNull()
      const last = removeModelTierCandidate('standard', 0).error as ShadowedModelTierError
      expect(last).toBeInstanceOf(ShadowedModelTierError)
      expect(last.settingsPath).toBe('models.standard')
      expect(readSaved().providers?.deepseek?.models?.standard).toEqual(scoped[1])
    })

    test('读取与运行时一致：优先当前 provider 的档位列表', () => {
      expect(getModelTierCandidates('standard').map((c) => c.model)).toEqual(['ds-a', 'ds-b'])
      expect(getModelCandidatesForTier('standard').map((c) => c.model)).toEqual(['ds-a', 'ds-b'])
      // provider 段未配置 advanced 时回落到顶层，与运行时顺序一致
      expect(getModelTierCandidates('advanced')).toEqual(advanced)
    })

    test('provider 档位中的隐式平台在编辑后仍保持原连接', () => {
      updateSettingsForSource('userSettings', {
        providers: { deepseek: { models: { standard: 'ds-implicit' } } },
      })
      expect(getModelTierCandidates('standard')).toEqual([
        { provider: 'deepseek', model: 'ds-implicit' },
      ])
      expect(
        addModelTierCandidate('standard', { provider: 'openai', model: 'gpt-4o' }).error,
      ).toBeNull()
      expect(getModelCandidatesForTier('standard')[0]?.provider).toBe('deepseek')
    })

    test('回落到其他 provider 档位时保留其隐式平台', () => {
      updateSettingsForSource('userSettings', {
        models: { advanced: undefined },
        providers: { ark: { models: { advanced: 'ark-implicit' } } },
      })
      expect(getModelTierCandidates('advanced')).toEqual([
        { provider: 'ark', model: 'ark-implicit' },
      ])
      expect(getModelCandidatesForTier('advanced')[0]?.provider).toBe('ark')
    })

    test('保存写入生效的 provider 段，保留顶层列表、其他档位与 provider 字段', () => {
      expect(
        saveModelTierSelection({
          tier: 'standard',
          provider: 'deepseek',
          model: 'ds-c',
          activate: false,
        }).error,
      ).toBeNull()
      const saved = readSaved()
      expect(saved.providers?.deepseek?.models?.standard).toEqual([
        { provider: 'deepseek', model: 'ds-c' },
        { provider: 'deepseek', model: 'ds-b' },
      ])
      expect(saved.providers?.deepseek?.baseUrl).toBe('https://fixture.example/v1')
      expect(saved.models?.standard).toEqual(oldStandard)
      expect(saved.models?.advanced).toEqual(advanced)
      expect(getModelCandidatesForTier('standard')[0]?.model).toBe('ds-c')
    })

    test('降级链编辑作用于 provider 段而不是顶层', () => {
      expect(reorderModelTierCandidates('standard', 1, 0).error).toBeNull()
      expect(readSaved().providers?.deepseek?.models?.standard).toEqual([scoped[1], scoped[0]])
      expect(clearModelTierFallbacks('standard').error).toBeNull()
      expect(readSaved().providers?.deepseek?.models?.standard).toEqual(scoped[1])
      expect(readSaved().models?.standard).toEqual(oldStandard)
    })

    test('仅顶层有档位时编辑顶层，不复制到 provider 段', () => {
      expect(
        addModelTierCandidate('advanced', { provider: 'deepseek', model: 'adv-2' }).error,
      ).toBeNull()
      expect(readSaved().models?.advanced).toEqual([
        ...advanced,
        { provider: 'deepseek', model: 'adv-2' },
      ])
      expect(readSaved().providers?.deepseek?.models?.advanced).toBeUndefined()
    })

    test('激活档位写入 provider 段主循环并清除两级 model 覆盖', () => {
      updateSettingsForSource('userSettings', {
        mainLoopModel: 'standard',
        providers: { deepseek: { model: 'pinned', mainLoopModel: 'standard' } },
      })
      const store = createStore(getDefaultAppState(), onChangeAppState)
      expect(
        saveModelTierSelection(
          { tier: 'advanced', provider: 'deepseek', model: 'adv-x', activate: true },
          store.setState,
        ).error,
      ).toBeNull()
      const saved = readSaved()
      expect(saved.providers?.deepseek?.mainLoopModel).toBe('advanced')
      expect(saved.providers?.deepseek?.model).toBeUndefined()
      expect(saved.model).toBeUndefined()
      expect(saved.providers?.deepseek?.models?.standard).toEqual(scoped)
      expect(saved.providers?.deepseek?.baseUrl).toBe('https://fixture.example/v1')
      setMainLoopModelOverride(undefined)
      resetSettingsCache()
      expect(getMainLoopModel()).toBe('adv-x')
    })

    test('清空 provider 档位会暴露旧顶层列表时拒绝写入', () => {
      expect(
        saveModelTierSelection({
          tier: 'standard',
          provider: 'deepseek',
          model: '',
          activate: false,
        }).error,
      ).toBeInstanceOf(Error)
      expect(readSaved().providers?.deepseek?.models?.standard).toEqual(scoped)
      expect(getModelCandidatesForTier('standard')[0]?.model).toBe('ds-a')
    })
  })

  test('同档位换到新模型时重新识别思考能力并清理旧强度', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'ark-personal': { provider: 'ark', apiKey: 'fixture-key', apiFormat: 'openai-responses' },
      }),
    )
    saveDiscoveredModelCapability(
      {
        model: 'catalog-only-model',
        provider: 'ark',
        connectionId: 'ark-personal',
        apiFormat: 'openai-responses',
      },
      {
        capabilities: { input: ['text', 'image'], thinking: { effort: ['on'] } },
        tokens: { contextWindow: 1048576 },
      },
    )
    const store = createStore<AppState>(
      {
        ...getDefaultAppState(),
        mainLoopModel: 'standard',
        thinkingEnabled: false,
        effortValue: 'extreme',
      },
      onChangeAppState,
    )
    expect(
      saveModelTierSelection(
        { tier: 'standard', provider: 'ark-personal', model: 'catalog-only-model', activate: true },
        store.setState,
      ).error,
    ).toBeNull()
    expect(store.getState().thinkingEnabled).toBe(true)
    expect(store.getState().effortValue).toBe('on')
  })

  test('界面明确禁用思考时，provider 默认支持不会重新打开它', () => {
    saveDiscoveredModelCapability(
      {
        model: 'Ling-user-model',
        provider: 'ant-ling',
        connectionId: 'ling-personal',
        apiFormat: 'openai-chat',
      },
      { capabilities: { thinking: { effort: ['off'] } } },
      'user',
    )
    const store = createStore(getDefaultAppState(), onChangeAppState)
    expect(
      saveModelTierSelection(
        { tier: 'standard', provider: 'ling-personal', model: 'Ling-user-model', activate: true },
        store.setState,
      ).error,
    ).toBeNull()
    expect(store.getState().thinkingEnabled).toBe(false)
    expect(store.getState().effortValue).toBeUndefined()
  })

  test('降级链显式管理：追加备选、调序、设为主选、移除与清空', () => {
    // 初始状态：standard 包含两个候选
    let candidates = getModelTierCandidates('standard')
    expect(candidates).toEqual([
      { provider: 'stepfun', model: 'old-model' },
      { provider: 'deepseek', model: 'backup-model' },
    ])

    // 1. 追加备选模型
    const addResult = addModelTierCandidate('standard', {
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(addResult.error).toBeNull()
    candidates = getModelTierCandidates('standard')
    expect(candidates).toHaveLength(3)
    expect(candidates[2]).toEqual({ provider: 'openai', model: 'gpt-4o' })

    // 重复追加应幂等
    addModelTierCandidate('standard', { provider: 'openai', model: 'gpt-4o' })
    expect(getModelTierCandidates('standard')).toHaveLength(3)

    // 2. 调序：将第 2 项（gpt-4o）设为主选（移到第 0 位）
    const reorderResult = reorderModelTierCandidates('standard', 2, 0)
    expect(reorderResult.error).toBeNull()
    candidates = getModelTierCandidates('standard')
    expect(candidates[0]).toEqual({ provider: 'openai', model: 'gpt-4o' })
    expect(candidates[1]).toEqual({ provider: 'stepfun', model: 'old-model' })
    expect(candidates[2]).toEqual({ provider: 'deepseek', model: 'backup-model' })

    // 3. 移除指定候选
    const removeResult = removeModelTierCandidate('standard', 1)
    expect(removeResult.error).toBeNull()
    candidates = getModelTierCandidates('standard')
    expect(candidates).toEqual([
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'deepseek', model: 'backup-model' },
    ])

    // 4. 清空备选：仅保留主选为单一模型
    const clearResult = clearModelTierFallbacks('standard')
    expect(clearResult.error).toBeNull()
    candidates = getModelTierCandidates('standard')
    expect(candidates).toEqual([{ provider: 'openai', model: 'gpt-4o' }])
    const saved = readSaved()
    expect(saved.models?.standard).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  test('保存与读取故障降级处理策略 (modelFailover policy)', () => {
    expect(saveModelFailoverPolicy({ mode: 'confirm', enabled: true }).error).toBeNull()
    let saved = readSaved()
    expect(saved.modelFailover?.mode).toBe('confirm')
    expect(saved.modelFailover?.enabled).toBe(true)

    expect(saveModelFailoverPolicy({ mode: 'off', enabled: false }).error).toBeNull()
    saved = readSaved()
    expect(saved.modelFailover?.mode).toBe('off')
    expect(saved.modelFailover?.enabled).toBe(false)
  })
})
