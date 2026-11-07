/**
 * 3.2 回归：permissions.deny 必须覆盖 PreToolUse hook 的 permissionDecision:"ask"。
 *
 * 背景：hook 返回 'ask' 时，结果会作为 forceDecision 透传给 canUseTool，
 * 后者跳过 hasPermissionsToUseTool（含 deny 规则检查）。修复后，'ask' 分支
 * 先跑 checkRuleBasedPermissions，命中 deny 则直接拒绝、不弹 prompt。
 * 对齐 Claude Code 2.1.101。
 */
import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from 'bun:test'
import * as realAnalytics from '../../../src/services/analytics/index.js'
import * as realMcpUtils from '../../../src/services/mcp/utils.js'
import * as realDebug from '../../../src/services/infra/debug.js'
import * as realHooks from '../../../src/services/hooks.js'
import * as realLog from '../../../src/services/infra/log.js'
import * as realPermissionResult from '../../../src/services/permissions/permissionResult.js'
import * as realToolErrors from '../../../src/services/tool-runtime/toolErrors.js'

// checkRuleBasedPermissions 的可控返回值（每个 case 单独设置）+ 调用计数。
const ruleCheck: { result: unknown; calls: number } = { result: null, calls: 0 }

import * as realPermissions from '../../../src/services/permissions/permissions.js'

async function setupMocks() {
  spyOn(realPermissions, 'checkRuleBasedPermissions').mockImplementation(async () => {
    ruleCheck.calls++
    return ruleCheck.result as Awaited<ReturnType<typeof realPermissions.checkRuleBasedPermissions>>
  })
  spyOn(realAnalytics, 'logEvent').mockImplementation(() => {})
  spyOn(realDebug, 'logForDebugging').mockImplementation(() => {})
  spyOn(realHooks, 'executePostToolHooks').mockImplementation(async function* () {})
  spyOn(realHooks, 'executePostToolUseFailureHooks').mockImplementation(async function* () {})
  spyOn(realHooks, 'executePreToolHooks').mockImplementation(async function* () {})
  spyOn(realHooks, 'getPreToolHookBlockingMessage').mockReturnValue('')
  spyOn(realLog, 'logError').mockImplementation(() => {})
  spyOn(realPermissionResult, 'getRuleBehaviorDescription').mockReturnValue('')
  spyOn(realToolErrors, 'formatError').mockImplementation((error) => String(error))
  spyOn(realMcpUtils, 'isMcpTool').mockReturnValue(false)
}

async function importSUT() {
  const mod = await import('../../../src/services/tool-runtime/toolHooks.js')
  return mod.resolveHookPermissionDecision
}

// biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
const tool = { name: 'Bash' } as any
const input = { command: 'rm -rf /' }
// biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
const toolUseContext = { requireCanUseTool: false, getAppState: () => ({}) } as any
// biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
const assistantMessage = {} as any
const toolUseID = 'tu_1'

describe('3.2 deny 覆盖 PreToolUse hook 的 ask', () => {
  beforeEach(async () => {
    ruleCheck.result = null
    ruleCheck.calls = 0
    await setupMocks()
  })
  afterEach(() => {
    mock.restore()
  })

  test('hook 返回 ask 且命中 deny 规则 → 直接 deny，不调用 canUseTool', async () => {
    const resolveHookPermissionDecision = await importSUT()
    ruleCheck.result = {
      behavior: 'deny',
      decisionReason: { type: 'rule' },
      message: 'denied by rule',
    }
    let canUseToolCalls = 0
    const canUseTool = async () => {
      canUseToolCalls++
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      return { behavior: 'ask' } as any
    }
    const out = await resolveHookPermissionDecision(
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      { behavior: 'ask' } as any,
      tool,
      input,
      toolUseContext,
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      canUseTool as any,
      assistantMessage,
      toolUseID,
    )
    expect(out.decision.behavior).toBe('deny')
    expect(canUseToolCalls).toBe(0)
    expect(ruleCheck.calls).toBe(1)
  })

  test('hook 返回 ask 且无 deny 规则 → 走 canUseTool 并透传 forceDecision', async () => {
    const resolveHookPermissionDecision = await importSUT()
    ruleCheck.result = null
    let receivedForceDecision: unknown
    const canUseTool = async (
      _t: unknown,
      _i: unknown,
      _c: unknown,
      _m: unknown,
      _id: unknown,
      forceDecision: unknown,
    ) => {
      receivedForceDecision = forceDecision
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      return { behavior: 'ask' } as any
    }
    const askResult = { behavior: 'ask', message: 'hook says ask' }
    const out = await resolveHookPermissionDecision(
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      askResult as any,
      tool,
      input,
      toolUseContext,
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      canUseTool as any,
      assistantMessage,
      toolUseID,
    )
    expect(out.decision.behavior).toBe('ask')
    expect(receivedForceDecision).toBe(askResult)
    expect(ruleCheck.calls).toBe(1)
  })

  test('无 hook 决策 → 不预检 deny（保持旧行为，canUseTool 自带 deny 检查）', async () => {
    const resolveHookPermissionDecision = await importSUT()
    let receivedForceDecision: unknown = 'sentinel'
    const canUseTool = async (
      _t: unknown,
      _i: unknown,
      _c: unknown,
      _m: unknown,
      _id: unknown,
      forceDecision: unknown,
    ) => {
      receivedForceDecision = forceDecision
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      return { behavior: 'allow' } as any
    }
    const out = await resolveHookPermissionDecision(
      undefined,
      tool,
      input,
      toolUseContext,
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
      canUseTool as any,
      assistantMessage,
      toolUseID,
    )
    expect(out.decision.behavior).toBe('allow')
    expect(receivedForceDecision).toBeUndefined()
    expect(ruleCheck.calls).toBe(0)
  })
})
