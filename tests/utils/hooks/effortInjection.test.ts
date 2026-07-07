/**
 * 3.3 effort 注入 —— getCurrentHookEffortLevel 解析 + createBaseHookInput 注入。
 *
 * 用真实 effort.js（避免 mock-vs-real 冲突），只 spread-real 覆盖控制 effort 档位的
 * 三个模块（当前模型 / 本地档位 / provider 档位）。createBaseHookInput 的其余轻量
 * 依赖按需 spread-real 覆盖。spread-real 保证导出完整，规避并发共享 mock 注册表的串扰。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let MODEL: string | undefined = 'test-model'
let LEVELS: string[] = ['light', 'balanced', 'thorough']

async function spread(path: string, overrides: Record<string, unknown>) {
  const real = await import(path)
  mock.module(path, () => ({ ...real, ...overrides }))
}

async function setupMocks() {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (k: string) => k,
    t: (k: string) => k,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  await spread('../../../src/services/model/model.js', { getMainLoopModel: () => MODEL })
  await spread('../../../src/utils/settings/localModelCapabilities.js', {
    getLocalModelEffortLevels: () => LEVELS,
  })
  // 不 mock providerRegistry（mock.restore 无法可靠恢复 ESM 缓存会导致跨文件污染）。
  // 改为 mock providers.js 的 getAPIProvider 返回不存在的 provider，
  // 让 getProviderEntry 自然返回 undefined，effort 走 localModelCapabilities 路径。
  await spread('../../../src/services/model/providers.js', {
    getAPIProvider: () => 'test-no-effort-provider',
  })
  await spread('../../../src/bootstrap/state.js', {
    getSessionId: () => 's1',
    getMainThreadAgentType: () => undefined,
  })
  await spread('../../../src/utils/sessionStorage.js', { getTranscriptPathForSession: () => '/t' })
  await spread('../../../src/utils/cwd.js', { getCwd: () => '/cwd' })
}

describe('3.3 effort 注入', () => {
  beforeEach(async () => {
    delete process.env.ZY_CODE_EFFORT_LEVEL
    delete process.env.ZY_CODE_ALWAYS_ENABLE_EFFORT
    MODEL = 'test-model'
    LEVELS = ['light', 'balanced', 'thorough']
    await setupMocks()
  })
  afterEach(() => mock.restore())

  describe('getCurrentHookEffortLevel', () => {
    test('模型支持 effort：返回传入档位', async () => {
      const { getCurrentHookEffortLevel } = await import('../../../src/utils/effort.js')
      expect(getCurrentHookEffortLevel('thorough')).toBe('thorough')
      expect(getCurrentHookEffortLevel('light')).toBe('light')
    })

    test('请求模型不支持的档位：夹取到可用档位', async () => {
      const { getCurrentHookEffortLevel } = await import('../../../src/utils/effort.js')
      expect(getCurrentHookEffortLevel('extreme')).toBe('thorough')
    })

    test('模型不支持 effort：返回 undefined', async () => {
      LEVELS = []
      const { getCurrentHookEffortLevel } = await import('../../../src/utils/effort.js')
      expect(getCurrentHookEffortLevel('thorough')).toBeUndefined()
    })

    test('无当前模型：返回 undefined', async () => {
      MODEL = undefined
      const { getCurrentHookEffortLevel } = await import('../../../src/utils/effort.js')
      expect(getCurrentHookEffortLevel('thorough')).toBeUndefined()
    })
  })

  describe('createBaseHookInput', () => {
    test('从 toolUseContext.getAppState().effortValue 读取并注入 effort', async () => {
      const { createBaseHookInput } = await import('../../../src/services/hooks/config.js')
      const thorough = createBaseHookInput(undefined, undefined, {
        getAppState: () => ({ effortValue: 'thorough' }),
      })
      expect(thorough.effort).toEqual({ level: 'thorough' })
      const light = createBaseHookInput(undefined, undefined, {
        getAppState: () => ({ effortValue: 'light' }),
      })
      expect(light.effort).toEqual({ level: 'light' })
    })

    test('模型不支持 effort 时不写入 effort 字段', async () => {
      LEVELS = []
      const { createBaseHookInput } = await import('../../../src/services/hooks/config.js')
      const out = createBaseHookInput(undefined, undefined, {
        getAppState: () => ({ effortValue: 'thorough' }),
      })
      expect('effort' in out).toBe(false)
    })
  })
})
