/**
 * fullscreen 分辨率函数测试：验证 resolveFullscreenEnabled() 的判断优先级和各分支。
 *
 * 用 mock.module 替换整个依赖链中的模块，阻断传递加载。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as realRuntimeContext from '../../src/bootstrap/runtime/runtimeContext.js'
import * as realGrowthbook from '../../src/services/analytics/growthbook.js'
import * as realConfig from '../../src/services/config/config.js'
import * as realConcurrentSessions from '../../src/services/session/concurrentSessions.js'
import * as realDebug from '../../src/utils/debug.js'
import * as realEnvUtils from '../../src/utils/envUtils.js'
import * as realExecFileNoThrow from '../../src/services/shell/execFileNoThrow.js'

// 可变的 mock 状态（测试之间重置）
let mockIsBgSession = false
let mockIsInternalBuild = false
let mockTuiConfig: 'fullscreen' | 'default' | undefined
let mockFeatureFlag = false

// 阻断所有传递依赖（spread 原始模块避免污染其他测试）
mock.module('../../src/i18n/index.js', () => ({
  tSync: (k: string) => k,
  t: (k: string) => k,
  getUiLanguage: () => 'en',
  warmI18n: async () => {},
  SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
}))

mock.module('../../src/utils/debug.js', () => ({
  ...realDebug,
  logForDebugging: () => {},
}))

// 通过正式运行时注入边界覆盖 fullscreen 依赖。
mock.module('../../src/bootstrap/runtime/runtimeContext.js', () => ({
  ...realRuntimeContext,
  getIsInteractive: () => true,
}))

mock.module('../../src/services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: () => mockFeatureFlag,
  getDynamicConfig_CACHED_MAY_BE_STALE: <T>(_k: string, d: T) => d,
  checkGate_CACHED_OR_BLOCKING: async () => false,
}))

mock.module('../../src/services/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({ tui: mockTuiConfig }),
  saveGlobalConfig: () => {},
  getGlobalConfigWriteCount: () => 0,
  createDefaultGlobalConfig: () => ({}),
}))

mock.module('../../src/services/session/concurrentSessions.js', () => ({
  ...realConcurrentSessions,
  isBgSession: () => mockIsBgSession,
}))

mock.module('../../src/utils/envUtils.js', () => ({
  ...realEnvUtils,
  isInternalBuild: () => mockIsInternalBuild,
}))

mock.module('../../src/services/shell/execFileNoThrow.js', () => ({
  ...realExecFileNoThrow,
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
  const mod = await import('../../src/services/terminal/fullscreen.js')
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

  test('/tui runtime override 可以在当前会话覆盖 env_on', async () => {
    process.env.ZY_CODE_NO_FLICKER = '1'
    const { resolveFullscreenEnabled, setFullscreenRuntimeOverride } = await getModule()
    setFullscreenRuntimeOverride('default')
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('runtime_off')
  })

  test('/tui runtime override 可以在当前会话开启 fullscreen', async () => {
    process.env.ZY_CODE_NO_FLICKER = '0'
    const { resolveFullscreenEnabled, setFullscreenRuntimeOverride } = await getModule()
    setFullscreenRuntimeOverride('fullscreen')
    const result = resolveFullscreenEnabled()
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('runtime_on')
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
  const savedPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform })
  })

  test('win32 + SSH → 禁用全屏（路径1：platform 判断）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.SSH_TTY = '/dev/pts/0'
    const { resolveFullscreenEnabled } = await getModule()
    expect(resolveFullscreenEnabled().reason).toBe('win_ssh_auto_off')
  })

  test('非 win32 + SSH + WT_SESSION → 禁用全屏（路径2：WT_SESSION 泄漏）', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.SSH_TTY = '/dev/pts/0'
    process.env.WT_SESSION = 'guid'
    const { resolveFullscreenEnabled } = await getModule()
    expect(resolveFullscreenEnabled().reason).toBe('win_ssh_auto_off')
  })

  test('非 win32 + SSH 但无 WT_SESSION → 不触发', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.SSH_TTY = '/dev/pts/0'
    const { resolveFullscreenEnabled } = await getModule()
    expect(resolveFullscreenEnabled().reason).not.toBe('win_ssh_auto_off')
  })
})
