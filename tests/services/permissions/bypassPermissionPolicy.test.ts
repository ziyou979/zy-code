/**
 * bypassPermissionPolicy 策略测试。
 *
 * 覆盖范围：
 *   - isBypassPermissionsModeDisabled：Statsig 门控和设置双重检查
 *   - createDisabledBypassPermissionsContext：上下文清理逻辑
 */
import { afterEach, beforeEach, describe, expect, test, mock, spyOn } from 'bun:test'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'
import * as growthbookActual from '../../../src/services/analytics/growthbook.js'
import * as settingsActual from '../../../src/services/settings/settings.js'
import * as permissionUpdateActual from '../../../src/services/permissions/permissionUpdate.js'

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

function registerMocks() {
  spyOn(growthbookActual, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(
    mockCheckStatsigGate,
  )
  spyOn(growthbookActual, 'checkSecurityRestrictionGate').mockImplementation(mockCheckSecurityGate)
  spyOn(settingsActual, 'getInitialSettings').mockImplementation(
    mockGetInitialSettings as typeof settingsActual.getInitialSettings,
  )
  spyOn(permissionUpdateActual, 'applyPermissionUpdate').mockImplementation(mockApplyUpdate)
}

// 动态加载被测模块；依赖函数只在每个用例执行期间替换。
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
