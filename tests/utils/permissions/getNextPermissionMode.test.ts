/**
 * getNextPermissionMode 测试：Shift+Tab 模式循环。
 *
 * 重点关注：
 * - 普通用户在 auto 可用时可从 default 切换到 auto
 * - auto 不可用时回退到 acceptEdits
 * - bypassPermissions 优先级高于 auto
 * - 各模式间的完整循环路径
 */
import { describe, expect, mock, test } from 'bun:test'

let autoModeGateEnabled = false

mock.module('../../../src/services/permissions/permissionSetup.js', () => ({
  isAutoModeGateEnabled: () => autoModeGateEnabled,
  getAutoModeUnavailableReason: () => (autoModeGateEnabled ? undefined : 'disabled'),
  transitionPermissionMode: (_from: string, _to: string, ctx: Record<string, unknown>) => ({
    ...ctx,
    mode: _to,
  }),
}))
mock.module('../../../src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

const { getNextPermissionMode } = await import(
  '../../../src/services/permissions/getNextPermissionMode.js'
)

function makeCtx(
  mode: string,
  overrides: {
    isBypassPermissionsModeAvailable?: boolean
    isAutoModeAvailable?: boolean
  } = {},
) {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: overrides.isBypassPermissionsModeAvailable ?? false,
    isAutoModeAvailable: overrides.isAutoModeAvailable ?? false,
  } as Parameters<typeof getNextPermissionMode>[0]
}

describe('getNextPermissionMode', () => {
  describe('auto 模式可用时', () => {
    test('default → auto（普通用户可切换）', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('default', { isAutoModeAvailable: true }))).toBe('auto')
    })

    test('plan → auto', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('plan', { isAutoModeAvailable: true }))).toBe('auto')
    })

    test('bypassPermissions → auto', () => {
      autoModeGateEnabled = true
      expect(
        getNextPermissionMode(makeCtx('bypassPermissions', { isAutoModeAvailable: true })),
      ).toBe('auto')
    })

    test('auto → acceptEdits（可继续切到 plan）', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('auto', { isAutoModeAvailable: true }))).toBe(
        'acceptEdits',
      )
    })
  })

  describe('auto 模式不可用时', () => {
    test('default → acceptEdits（回退）', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('default'))).toBe('acceptEdits')
    })

    test('plan → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('plan'))).toBe('default')
    })

    test('bypassPermissions → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('bypassPermissions'))).toBe('default')
    })
  })

  describe('bypassPermissions 优先级', () => {
    test('default 且 bypassPermissions 可用时优先返回 bypassPermissions', () => {
      autoModeGateEnabled = true
      expect(
        getNextPermissionMode(
          makeCtx('default', {
            isBypassPermissionsModeAvailable: true,
            isAutoModeAvailable: true,
          }),
        ),
      ).toBe('bypassPermissions')
    })

    test('plan 且 bypassPermissions 可用时优先返回 bypassPermissions', () => {
      autoModeGateEnabled = true
      expect(
        getNextPermissionMode(
          makeCtx('plan', {
            isBypassPermissionsModeAvailable: true,
            isAutoModeAvailable: true,
          }),
        ),
      ).toBe('bypassPermissions')
    })
  })

  describe('固定路径', () => {
    test('acceptEdits → plan', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('acceptEdits'))).toBe('plan')
    })

    test('dontAsk → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('dontAsk'))).toBe('default')
    })
  })

  describe('gate 部分开启', () => {
    test('isAutoModeAvailable=true 但 gate 关闭 → 不切 auto', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('default', { isAutoModeAvailable: true }))).toBe(
        'acceptEdits',
      )
    })

    test('gate 开启但 isAutoModeAvailable=false → 不切 auto', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('default', { isAutoModeAvailable: false }))).toBe(
        'acceptEdits',
      )
    })
  })
})
