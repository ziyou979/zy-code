/**
 * /goal 命令实现 — 通过 session-scoped Stop hook 驱动模型持续工作直到条件满足。
 * 类型为 local-jsx，使用 onDone 回调的 shouldQuery + metaMessages 触发模型。
 */

import { getSessionId } from '../../bootstrap/state.js'
import { getTotalInputTokens } from '../../cost-tracker.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import { addSessionHook, removeSessionHook } from '../../utils/hooks/sessionHooks.js'
import type { HookCommand } from '../../utils/settings/types.js'

/** 条件字符上限 */
const MAX_CONDITION_LENGTH = 4000

/** 清除关键词集合 */
const CLEAR_KEYWORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

function isClearKeyword(input: string): boolean {
  return CLEAR_KEYWORDS.has(input.toLowerCase())
}

/**
 * 守卫检查：确保 hooks 可用且工作区受信任
 */
function checkGates(): { message: string; code: string } | null {
  if (shouldDisableAllHooksIncludingManaged() || shouldAllowManagedHooksOnly()) {
    return {
      message:
        "/goal can't run while hooks are disabled (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).",
      code: 'hooks_gate',
    }
  }
  if (!checkHasTrustDialogAccepted()) {
    return {
      message:
        '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.',
      code: 'trust_gate',
    }
  }
  return null
}

/**
 * 生成注入给模型的 meta message，驱动模型立即开始工作
 */
function buildGoalMetaMessage(condition: string): string {
  return (
    `A session-scoped Stop hook is now active with condition: "${condition}". ` +
    'Briefly acknowledge the goal, then immediately start (or continue) working toward it — ' +
    'treat the condition itself as your directive and do not pause to ask the user what to do. ' +
    'The hook will block stopping until the condition holds. ' +
    'It auto-clears once the condition is met — do not tell the user to run `/goal clear` after success; ' +
    "that's only for clearing a goal early."
  )
}

/**
 * 设置目标：注册 Stop hook + 写入 activeGoal 状态
 */
// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
function setGoal(condition: string, setAppState: (f: (prev: any) => any) => void): string | null {
  const gate = checkGates()
  if (gate !== null) {
    return gate.message
  }

  const sessionId = getSessionId()

  // 注册新的 type: 'prompt' 的 Stop hook
  const hook: HookCommand = { type: 'prompt', prompt: condition }
  addSessionHook(setAppState, sessionId, 'Stop', '', hook)

  // 写入 activeGoal 状态
  const goalState = {
    condition,
    iterations: 0,
    setAt: Date.now(),
    tokensAtStart: getTotalInputTokens(),
  }
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  setAppState((prev: any) => ({ ...prev, activeGoal: goalState }))

  logEvent('zy_stop_hook_added', {
    promptLength: condition.length,
  })
  logForDebugging(`/goal set: "${condition}"`)

  return null
}

/**
 * 清除目标：移除 Stop hook + 清除 activeGoal 状态
 * 返回被清除的 condition（无活跃目标时返回 null）
 */
function clearGoal(
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  setAppState: (f: (prev: any) => any) => void,
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  getAppState: () => any,
): string | null {
  const state = getAppState()
  const activeGoal = state.activeGoal
  if (!activeGoal) {
    return null
  }

  clearGoalHooks(setAppState, activeGoal.condition)

  // 清除 activeGoal 状态
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  setAppState((prev: any) => ({ ...prev, activeGoal: undefined }))

  logEvent('zy_stop_hook_removed', {})
  logForDebugging(`/goal cleared: "${activeGoal.condition}"`)

  return activeGoal.condition
}

/**
 * 移除当前 goal 的 Stop hook
 */
// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
function clearGoalHooks(setAppState: (f: (prev: any) => any) => void, condition?: string): void {
  if (!condition) {
    return
  }
  const sessionId = getSessionId()
  const hook: HookCommand = { type: 'prompt', prompt: condition }
  removeSessionHook(setAppState, sessionId, 'Stop', hook)
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmedArgs = args.trim()

  // /goal（空）— 显示当前状态
  if (!trimmedArgs) {
    const activeGoal = context.getAppState().activeGoal
    if (!activeGoal) {
      onDone('No goal set. Usage: `/goal <condition>`', { display: 'system' })
      return null
    }
    const iterationText =
      activeGoal.iterations === 0
        ? 'not yet evaluated'
        : `${activeGoal.iterations} turn${activeGoal.iterations === 1 ? '' : 's'}`
    const reasonText = activeGoal.lastReason ? `\nLast reason: ${activeGoal.lastReason}` : ''
    onDone(`Goal active: ${activeGoal.condition} (${iterationText})${reasonText}`, {
      display: 'system',
    })
    return null
  }

  // 清除关键词
  if (isClearKeyword(trimmedArgs)) {
    const cleared = clearGoal(context.setAppState, context.getAppState)
    onDone(cleared === null ? 'No goal set' : `Goal cleared: ${cleared}`, { display: 'system' })
    return null
  }

  // 条件长度检查
  if (trimmedArgs.length > MAX_CONDITION_LENGTH) {
    onDone(
      `Goal condition is limited to ${MAX_CONDITION_LENGTH} characters (got ${trimmedArgs.length})`,
      { display: 'system' },
    )
    return null
  }

  // 设置目标
  const error = setGoal(trimmedArgs, context.setAppState)
  if (error !== null) {
    onDone(error, { display: 'system' })
    return null
  }

  // 触发模型：shouldQuery + metaMessages
  onDone(`Goal set: ${trimmedArgs}`, {
    shouldQuery: true,
    metaMessages: [buildGoalMetaMessage(trimmedArgs)],
  })
  return null
}
