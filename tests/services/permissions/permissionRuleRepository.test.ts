/**
 * permissionRuleRepository 事务行为测试。
 *
 * 覆盖范围：
 *   - 只读来源抛出错误
 *   - 磁盘写入失败时的行为
 *   - 规则不存在时无副作用
 *   - session/cliArg 来源不触发磁盘写入
 *   - 删除后内存上下文同步
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'
import type { PermissionRule } from '../../../src/services/permissions/permissionRule.js'

// 模拟 permissionsLoader 中的 deletePermissionRuleFromSettings
const mockDeleteFromSettings = mock<(rule: { source: string }) => boolean>(() => true)
mock.module('../../../src/services/permissions/permissionsLoader.js', () => ({
  deletePermissionRuleFromSettings: mockDeleteFromSettings,
}))

// 模拟 permissionUpdate 中的 applyPermissionUpdate
const mockApplyUpdate = mock<
  (ctx: ToolPermissionContext, update: unknown) => ToolPermissionContext
>((ctx, _update) => ctx)
mock.module('../../../src/services/permissions/permissionUpdate.js', () => ({
  applyPermissionUpdate: mockApplyUpdate,
}))

// 在所有 mock 之后导入被测模块
const { deletePermissionRule } = await import(
  '../../../src/services/permissions/permissionRuleRepository.js'
)

function createMockContext(overrides?: Partial<ToolPermissionContext>): ToolPermissionContext {
  return {
    mode: 'default' as const,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    alwaysDenyRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    alwaysAskRules: { session: [], userSettings: [], projectSettings: [], localSettings: [] },
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

describe('deletePermissionRule', () => {
  let setContext: ReturnType<typeof mock>

  beforeEach(() => {
    mockDeleteFromSettings.mockClear()
    mockDeleteFromSettings.mockImplementation(() => true)
    mockApplyUpdate.mockClear()
    mockApplyUpdate.mockReturnValue(createMockContext())
    setContext = mock<(ctx: ToolPermissionContext) => void>(() => {})
  })

  // -----------------------------------------------------------------------
  //  只读来源
  // -----------------------------------------------------------------------
  test('policySettings 来源抛出错误', async () => {
    const rule: PermissionRule = {
      source: 'policySettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'ls' },
    }
    await expect(
      deletePermissionRule({
        rule,
        initialContext: createMockContext(),
        setToolPermissionContext: setContext,
      }),
    ).rejects.toThrow('Cannot delete permission rules from read-only settings')
    expect(setContext).not.toHaveBeenCalled()
  })

  test('flagSettings 来源抛出错误', async () => {
    const rule: PermissionRule = {
      source: 'flagSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Edit' },
    }
    await expect(
      deletePermissionRule({
        rule,
        initialContext: createMockContext(),
        setToolPermissionContext: setContext,
      }),
    ).rejects.toThrow('Cannot delete permission rules from read-only settings')
    expect(setContext).not.toHaveBeenCalled()
  })

  test('command 来源抛出错误', async () => {
    const rule: PermissionRule = {
      source: 'command',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash' },
    }
    await expect(
      deletePermissionRule({
        rule,
        initialContext: createMockContext(),
        setToolPermissionContext: setContext,
      }),
    ).rejects.toThrow('Cannot delete permission rules from read-only settings')
    expect(setContext).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  //  磁盘写入失败
  // -----------------------------------------------------------------------
  test('deletePermissionRuleFromSettings 返回 false 时保持内存不变', async () => {
    mockDeleteFromSettings.mockReturnValue(false)
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    // 持久化失败，不更新内存
    expect(setContext).not.toHaveBeenCalled()
  })

  test('deletePermissionRuleFromSettings 抛出异常时保持内存不变', async () => {
    mockDeleteFromSettings.mockImplementation(() => {
      throw new Error('Disk full')
    })
    const rule: PermissionRule = {
      source: 'projectSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'FileWrite' },
    }
    await expect(
      deletePermissionRule({
        rule,
        initialContext: createMockContext(),
        setToolPermissionContext: setContext,
      }),
    ).rejects.toThrow('Disk full')
    // 异常传播，不更新内存
    expect(setContext).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  //  规则不存在时无副作用
  // -----------------------------------------------------------------------
  test('规则不存在时依然调用 applyPermissionUpdate（过滤是无副作用的）', async () => {
    const rule: PermissionRule = {
      source: 'session',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Glob' },
    }
    mockApplyUpdate.mockReturnValue(createMockContext())
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1)
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  // -----------------------------------------------------------------------
  //  session/cliArg 不触发磁盘写入
  // -----------------------------------------------------------------------
  test('session 来源不调用 deletePermissionRuleFromSettings', async () => {
    const rule: PermissionRule = {
      source: 'session',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Read' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockDeleteFromSettings).not.toHaveBeenCalled()
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  test('cliArg 来源不调用 deletePermissionRuleFromSettings', async () => {
    const rule: PermissionRule = {
      source: 'cliArg',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Write' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockDeleteFromSettings).not.toHaveBeenCalled()
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  // -----------------------------------------------------------------------
  //  内存同步确认
  // -----------------------------------------------------------------------
  test('userSettings 来源触发 applyPermissionUpdate 和 deletePermissionRuleFromSettings', async () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'ls' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1)
    expect(mockDeleteFromSettings).toHaveBeenCalledTimes(1)
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  test('localSettings 来源触发 applyPermissionUpdate 和 deletePermissionRuleFromSettings', async () => {
    const rule: PermissionRule = {
      source: 'localSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Glob' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1)
    expect(mockDeleteFromSettings).toHaveBeenCalledTimes(1)
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  test('projectSettings 来源触发 applyPermissionUpdate 和 deletePermissionRuleFromSettings', async () => {
    const rule: PermissionRule = {
      source: 'projectSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Edit' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(mockApplyUpdate).toHaveBeenCalledTimes(1)
    expect(mockDeleteFromSettings).toHaveBeenCalledTimes(1)
    expect(setContext).toHaveBeenCalledTimes(1)
  })

  test('applyPermissionUpdate 的返回值被传递到 setToolPermissionContext', async () => {
    const updatedContext = createMockContext({ mode: 'acceptEdits' })
    mockApplyUpdate.mockReturnValue(updatedContext)
    const rule: PermissionRule = {
      source: 'session',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash' },
    }
    await deletePermissionRule({
      rule,
      initialContext: createMockContext(),
      setToolPermissionContext: setContext,
    })
    expect(setContext).toHaveBeenCalledWith(updatedContext)
  })
})
