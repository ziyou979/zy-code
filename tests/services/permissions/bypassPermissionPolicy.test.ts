/**
 * bypassPermissionPolicy 策略测试。
 *
 * 覆盖范围：
 *   - isBypassPermissionsModeDisabled：Statsig 门控和设置双重检查
 *   - createDisabledBypassPermissionsContext：上下文清理逻辑
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as growthbookActual from '../../../src/services/analytics/growthbook.js'
import * as settingsActual from '../../../src/services/settings/settings.js'
import * as permissionUpdateActual from '../../../src/services/permissions/permissionUpdate.js'
import * as gracefulShutdownActual from '../../../src/bootstrap/lifecycle/gracefulShutdown.js'

// mock.module 是进程级全局替换且 mock.restore() 不撤销它：此前窄面 mock
// （growthbook 只给两个 gate、settings 只给 getInitialSettings）丢失其余导出
// （如 getFeatureValue_CACHED_MAY_BE_STALE），泄漏给同 worker 后续文件报
// "Export named ... not found"。统一改为真实快照 spread + 仅覆盖所需导出；
// fake 只在测试体内登记，afterEach 恢复真实快照、afterAll 兜底，把泄漏窗口
// 限制在本文件执行期内。
const MOCK_PATHS = {
  growthbook: '../../../src/services/analytics/growthbook.js',
  settings: '../../../src/services/settings/settings.js',
  permissionUpdate: '../../../src/services/permissions/permissionUpdate.js',
  gracefulShutdown: '../../../src/bootstrap/lifecycle/gracefulShutdown.js',
} as const

// mock: Statsig 门控（spread-real 保证其余导出完整）
const mockCheckStatsigGate = mock<(gate: string) => boolean>(() => false)
const mockCheckSecurityGate = mock<(gate: string) => Promise<boolean>>(async () => false)

// mock settings
let mockSettings: { permissions?: { disableBypassPermissionsMode?: string } } | null = {}
const mockGetInitialSettings = mock(() => mockSettings)

// mock permissionUpdate
const mockApplyUpdate = mock<
  (ctx: ToolPermissionContext, update: unknown) => ToolPermissionContext
>((ctx, _update) => ctx)

// mock gracefulShutdown
const mockGracefulShutdown = mock<(code: number, reason: string) => void>(() => {})

function registerMocks() {
  mock.module(MOCK_PATHS.growthbook, () => ({
    ...growthbookActual,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: mockCheckStatsigGate,
    checkSecurityRestrictionGate: mockCheckSecurityGate,
  }))
  mock.module(MOCK_PATHS.settings, () => ({
    ...settingsActual,
    getInitialSettings: mockGetInitialSettings,
  }))
  mock.module(MOCK_PATHS.permissionUpdate, () => ({
    ...permissionUpdateActual,
    applyPermissionUpdate: mockApplyUpdate,
  }))
  mock.module(MOCK_PATHS.gracefulShutdown, () => ({
    ...gracefulShutdownActual,
    gracefulShutdown: mockGracefulShutdown,
  }))
}

function restoreRealModules() {
  mock.module(MOCK_PATHS.growthbook, () => ({ ...growthbookActual }))
  mock.module(MOCK_PATHS.settings, () => ({ ...settingsActual }))
  mock.module(MOCK_PATHS.permissionUpdate, () => ({ ...permissionUpdateActual }))
  mock.module(MOCK_PATHS.gracefulShutdown, () => ({ ...gracefulShutdownActual }))
}

// 在 mock.module 就位之后再导入被测模块
const { isBypassPermissionsModeDisabled, createDisabledBypassPermissionsContext } = await import(
  '../../../src/services/permissions/bypassPermissionPolicy.js'
)

function createCtx(overrides?: Partial<ToolPermissionContext>): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    alwaysDenyRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    alwaysAskRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

describe('isBypassPermissionsModeDisabled', () => {
  beforeEach(() => {
    registerMocks()
    mockCheckStatsigGate.mockClear()
    mockCheckStatsigGate.mockImplementation(() => false)
    mockSettings = {}
  })

  afterEach(() => {
    mock.restore()
    restoreRealModules()
  })

  test('默认不禁用', () => {
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })

  test('Statsig 门控开启时禁用', () => {
    mockCheckStatsigGate.mockImplementation(() => true)
    expect(isBypassPermissionsModeDisabled()).toBe(true)
  })

  test('设置中 disableBypassPermissionsMode 为 disable 时禁用', () => {
    mockSettings = { permissions: { disableBypassPermissionsMode: 'disable' } }
    expect(isBypassPermissionsModeDisabled()).toBe(true)
  })

  test('settings 为 null 时不崩溃', () => {
    mockSettings = null
    // Statsig 为 false 且 settings 为 null 时返回 false
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })

  test('设置中 disableBypassPermissionsMode 为其他值时不禁用', () => {
    mockSettings = { permissions: { disableBypassPermissionsMode: 'other' } }
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })
})

describe('createDisabledBypassPermissionsContext', () => {
  beforeEach(() => {
    registerMocks()
    mockApplyUpdate.mockClear()
    mockApplyUpdate.mockImplementation((ctx, _update) => ctx)
  })

  afterEach(() => {
    mock.restore()
    restoreRealModules()
  })

  test('非 bypassPermissions 模式仅设置 isBypassPermissionsModeAvailable=false', () => {
    const ctx = createCtx({ mode: 'default', isBypassPermissionsModeAvailable: true })
    const result = createDisabledBypassPermissionsContext(ctx)
    expect(result.isBypassPermissionsModeAvailable).toBe(false)
    expect(result.mode).toBe('default')
    expect(mockApplyUpdate).not.toHaveBeenCalled()
  })

  test('bypassPermissions 模式时调用 applyPermissionUpdate 降级为 default', () => {
    const ctx = createCtx({ mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true })
    const result = createDisabledBypassPermissionsContext(ctx)
    expect(result.isBypassPermissionsModeAvailable).toBe(false)
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1)
  })
})

afterAll(() => {
  restoreRealModules()
})
