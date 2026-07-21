/**
 * getNextPermissionMode 测试：Shift+Tab 模式循环。
 *
 * 循环顺序：权限等级递增
 *   default(手动) → plan → acceptEdits → auto(可选) → bypassPermissions(可选) → default
 *
 * 重点验证：
 * - 始终从 default（手动模式）开始递增
 * - auto 和 bypassPermissions 只在可用时出现在循环中
 * - 循环闭合回到 default
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
mock.module('../../../src/services/infra/debug.js', () => ({
  logForDebugging: () => {},
  createDebugLog: () => () => {},
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
  describe('全部模式可用时：default → plan → acceptEdits → auto → bypass → default', () => {
    const opts = { isAutoModeAvailable: true, isBypassPermissionsModeAvailable: true }

    test('default → plan', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('default', opts))).toBe('plan')
    })

    test('plan → acceptEdits', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('plan', opts))).toBe('acceptEdits')
    })

    test('acceptEdits → auto（auto 可用时优先于 bypass）', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('acceptEdits', opts))).toBe('auto')
    })

    test('auto → bypassPermissions', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('auto', opts))).toBe('bypassPermissions')
    })

    test('bypassPermissions → default（循环闭合）', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('bypassPermissions', opts))).toBe('default')
    })
  })

  describe('仅 auto 可用时：default → plan → acceptEdits → auto → default', () => {
    const opts = { isAutoModeAvailable: true, isBypassPermissionsModeAvailable: false }

    test('acceptEdits → auto', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('acceptEdits', opts))).toBe('auto')
    })

    test('auto → default（无 bypass 时回到手动模式）', () => {
      autoModeGateEnabled = true
      expect(getNextPermissionMode(makeCtx('auto', opts))).toBe('default')
    })
  })

  describe('仅 bypassPermissions 可用时：default → plan → acceptEdits → bypass → default', () => {
    const opts = { isAutoModeAvailable: false, isBypassPermissionsModeAvailable: true }

    test('acceptEdits → bypassPermissions', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('acceptEdits', opts))).toBe('bypassPermissions')
    })

    test('bypassPermissions → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('bypassPermissions', opts))).toBe('default')
    })
  })

  describe('auto 和 bypass 均不可用时：default → plan → acceptEdits → default', () => {
    test('default → plan', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('default'))).toBe('plan')
    })

    test('plan → acceptEdits', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('plan'))).toBe('acceptEdits')
    })

    test('acceptEdits → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('acceptEdits'))).toBe('default')
    })
  })

  describe('gate 部分开启', () => {
    test('isAutoModeAvailable=true 但 gate 关闭 → acceptEdits 跳过 auto 到 default', () => {
      autoModeGateEnabled = false
      expect(
        getNextPermissionMode(
          makeCtx('acceptEdits', {
            isAutoModeAvailable: true,
            isBypassPermissionsModeAvailable: false,
          }),
        ),
      ).toBe('default')
    })

    test('gate 开启但 isAutoModeAvailable=false → acceptEdits 跳过 auto 到 default', () => {
      autoModeGateEnabled = true
      expect(
        getNextPermissionMode(
          makeCtx('acceptEdits', {
            isAutoModeAvailable: false,
            isBypassPermissionsModeAvailable: false,
          }),
        ),
      ).toBe('default')
    })
  })

  describe('特殊模式', () => {
    test('dontAsk → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('dontAsk'))).toBe('default')
    })

    test('未知模式 → default', () => {
      autoModeGateEnabled = false
      expect(getNextPermissionMode(makeCtx('unknown' as string))).toBe('default')
    })
  })

  describe('完整循环验证', () => {
    test('所有模式可用时完整循环：default → plan → acceptEdits → auto → bypass → default', () => {
      autoModeGateEnabled = true
      const opts = { isAutoModeAvailable: true, isBypassPermissionsModeAvailable: true }
      const order: string[] = ['default']
      let currentMode: string = 'default'
      for (let i = 0; i < 10; i++) {
        const next = getNextPermissionMode(makeCtx(currentMode, opts))
        order.push(next)
        if (next === 'default') break
        currentMode = next
      }
      expect(order).toEqual([
        'default',
        'plan',
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'default',
      ])
    })

    test('仅 auto 可用时完整循环', () => {
      autoModeGateEnabled = true
      const opts = { isAutoModeAvailable: true, isBypassPermissionsModeAvailable: false }
      const order: string[] = ['default']
      let currentMode: string = 'default'
      for (let i = 0; i < 10; i++) {
        const next = getNextPermissionMode(makeCtx(currentMode, opts))
        order.push(next)
        if (next === 'default') break
        currentMode = next
      }
      expect(order).toEqual(['default', 'plan', 'acceptEdits', 'auto', 'default'])
    })

    test('仅 bypass 可用时完整循环', () => {
      autoModeGateEnabled = false
      const opts = { isAutoModeAvailable: false, isBypassPermissionsModeAvailable: true }
      const order: string[] = ['default']
      let currentMode: string = 'default'
      for (let i = 0; i < 10; i++) {
        const next = getNextPermissionMode(makeCtx(currentMode, opts))
        order.push(next)
        if (next === 'default') break
        currentMode = next
      }
      expect(order).toEqual(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'default'])
    })

    test('均不可用时完整循环', () => {
      autoModeGateEnabled = false
      const order: string[] = ['default']
      let currentMode: string = 'default'
      for (let i = 0; i < 10; i++) {
        const next = getNextPermissionMode(makeCtx(currentMode))
        order.push(next)
        if (next === 'default') break
        currentMode = next
      }
      expect(order).toEqual(['default', 'plan', 'acceptEdits', 'default'])
    })
  })
})
