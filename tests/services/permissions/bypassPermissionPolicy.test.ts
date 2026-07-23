/**
 * bypassPermissionPolicy 策略测试。
 *
 * 覆盖范围：
 *   - isBypassPermissionsModeDisabled：Statsig 门控和设置双重检查
 *   - createDisabledBypassPermissionsContext：上下文清理逻辑
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'

// mock: Statsig 门控（必须导出所有被模块引用的符号）
const mockCheckStatsigGate = mock<(gate: string) => boolean>(() => false)
const mockCheckSecurityGate = mock<(gate: string) => Promise<boolean>>(async () => false)
mock.module('src/services/analytics/growthbook.js', () => ({
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: mockCheckStatsigGate,
  checkSecurityRestrictionGate: mockCheckSecurityGate,
}))

// mock: settings
let mockSettings: { permissions?: { disableBypassPermissionsMode?: string } } | null = {}
const mockGetInitialSettings = mock(() => mockSettings)
mock.module('../../../src/services/settings/settings.js', () => ({
  getInitialSettings: mockGetInitialSettings,
}))

// mock: permissionUpdate
const mockApplyUpdate = mock<
  (ctx: ToolPermissionContext, update: unknown) => ToolPermissionContext
>((ctx, _update) => ctx)
mock.module('../../../src/services/permissions/permissionUpdate.js', () => ({
  applyPermissionUpdate: mockApplyUpdate,
}))

// mock: gracefulShutdown
const mockGracefulShutdown = mock<(code: number, reason: string) => void>(() => {})
mock.module('../../../src/bootstrap/lifecycle/gracefulShutdown.js', () => ({
  gracefulShutdown: mockGracefulShutdown,
}))

// 在所有 mock 之后导入被测模块
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
    mockCheckStatsigGate.mockClear()
    mockCheckStatsigGate.mockImplementation(() => false)
    mockSettings = {}
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
    // Statsig false + settings null → false
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })

  test('设置中 disableBypassPermissionsMode 为其他值时不禁用', () => {
    mockSettings = { permissions: { disableBypassPermissionsMode: 'other' } }
    expect(isBypassPermissionsModeDisabled()).toBe(false)
  })
})

describe('createDisabledBypassPermissionsContext', () => {
  beforeEach(() => {
    mockApplyUpdate.mockClear()
    mockApplyUpdate.mockImplementation((ctx, _update) => ctx)
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
