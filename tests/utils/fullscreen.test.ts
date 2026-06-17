/**
 * fullscreen 分辨率函数测试：验证 resolveFullscreenEnabled() 的判断优先级和各分支。
 *
 * 用 mock.module 替换整个依赖链中的模块，阻断传递加载。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'

// 可变的 mock 状态（测试之间重置）
let mockIsBgSession = false
let mockIsInternalBuild = false
let mockTuiConfig: 'fullscreen' | 'default' | undefined
let mockFeatureFlag = false

// 阻断所有传递依赖
mock.module('../../src/i18n/index.js', () => ({
  tSync: (k: string) => k,
  t: (k: string) => k,
  getUiLanguage: () => 'en',
  warmI18n: async () => {},
  SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
}))

mock.module('../../src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

mock.module('../../src/bootstrap/state.js', () => ({
  getIsInteractive: () => true,
  addSlowOperation: () => {},
  flushInteractionTime: () => {},
  getSessionId: () => 'test',
  getTotalInputTokens: () => 0,
  getCwdState: () => ({ cwd: '/' }),
}))

mock.module('../../src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => mockFeatureFlag,
  getDynamicConfig_CACHED_MAY_BE_STALE: <T>(_k: string, d: T) => d,
  checkGate_CACHED_OR_BLOCKING: async () => false,
}))

mock.module('../../src/services/config/config.js', () => ({
  getGlobalConfig: () => ({ tui: mockTuiConfig }),
  saveGlobalConfig: () => {},
  getGlobalConfigWriteCount: () => 0,
  createDefaultGlobalConfig: () => ({}),
}))

mock.module('../../src/utils/concurrentSessions.js', () => ({
  isBgSession: () => mockIsBgSession,
}))

mock.module('../../src/utils/envUtils.js', () => ({
  isEnvTruthy: (v: unknown) => v === '1' || v === 'true' || v === true,
  isEnvDefinedFalsy: (v: unknown) => v === '0' || v === 'false',
  isInternalBuild: () => mockIsInternalBuild,
}))

mock.module('../../src/utils/execFileNoThrow.js', () => ({
  execFileNoThrow: async () => ({ stdout: '', code: 1 }),
}))

afterEach(() => {
  mockIsBgSession = false
  mockIsInternalBuild = false
  mockTuiConfig = undefined
  mockFeatureFlag = false
  delete process.env.ZY_CODE_NO_FLICKER
  delete process.env.SSH_CONNECTION
  delete process.env.SSH_CLIENT
  delete process.env.SSH_TTY
  delete process.env.WT_SESSION
  delete process.env.TMUX
  delete process.env.ZY_CODE_DISABLE_ALTERNATE_SCREEN
})

async function getModule() {
  const mod = await import('../../src/utils/fullscreen.js')
  mod._resetForTesting()
  mod._resetTmuxControlModeProbeForTesting()
  return mod
}

describe('resolveFullscreenEnabled', () => {
  test('后台会话 → bg_forced_on（最高优先级，覆盖 env_off）', async () => {
    mockIsBgSession = true
    process.env.ZY_CODE_NO_FLICKER = '0'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('bg_forced_on')
  })

  test('ZY_CODE_NO_FLICKER=0 → env_off', async () => {
    process.env.ZY_CODE_NO_FLICKER = '0'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('env_off')
  })

  test('ZY_CODE_NO_FLICKER=1 → env_on', async () => {
    process.env.ZY_CODE_NO_FLICKER = '1'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('env_on')
  })

  test('Windows+SSH (WT_SESSION) → win_ssh_auto_off', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4 5678 5.6.7.8 22'
    process.env.WT_SESSION = 'some-guid'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('win_ssh_auto_off')
  })

  test('settings.tui=fullscreen → settings_on', async () => {
    mockTuiConfig = 'fullscreen'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('settings_on')
  })

  test('settings.tui=default → settings_off', async () => {
    mockTuiConfig = 'default'
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('settings_off')
  })

  test('内部构建 → internal_default', async () => {
    mockIsInternalBuild = true
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('internal_default')
  })

  test('外部构建 + feature flag=true → feature_flag_on', async () => {
    mockFeatureFlag = true
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('feature_flag_on')
  })

  test('外部构建 + feature flag=false → external_default_off', async () => {
    const { resolveFullscreenEnabled } = await getModule()
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('external_default_off')
  })
})

describe('isAlternateScreenDisabled', () => {
  test('ZY_CODE_DISABLE_ALTERNATE_SCREEN=1 → true', async () => {
    process.env.ZY_CODE_DISABLE_ALTERNATE_SCREEN = '1'
    const { isAlternateScreenDisabled } = await getModule()
    expect(isAlternateScreenDisabled()).toBe(true)
  })

  test('未设置 → false', async () => {
    const { isAlternateScreenDisabled } = await getModule()
    expect(isAlternateScreenDisabled()).toBe(false)
  })
})

describe('isFullscreenActive', () => {
  test('interactive + fullscreen enabled → true', async () => {
    mockIsInternalBuild = true
    const { isFullscreenActive } = await getModule()
    expect(isFullscreenActive()).toBe(true)
  })
})

describe('isWindowsOverSsh 检测', () => {
  test('SSH + WT_SESSION → 禁用全屏', async () => {
    process.env.SSH_TTY = '/dev/pts/0'
    process.env.WT_SESSION = 'guid'
    const { resolveFullscreenEnabled } = await getModule()
    expect(resolveFullscreenEnabled().reason).toBe('win_ssh_auto_off')
  })

  test('SSH 但无 WT_SESSION 且非 win32 → 不触发', async () => {
    process.env.SSH_TTY = '/dev/pts/0'
    const { resolveFullscreenEnabled } = await getModule()
    expect(resolveFullscreenEnabled().reason).not.toBe('win_ssh_auto_off')
  })
})
