import {
  getIsNonInteractiveSession,
  getMainThreadAgentType,
  getSessionId,
} from '../../bootstrap/runtime/runtimeContext.js'
import { checkHasTrustDialogAccepted } from '../config/config.js'
import { getCwd } from '../environment/cwd.js'
import { type EffortLevel, getCurrentHookEffortLevel } from '../effort/effort.js'
import { getTranscriptPathForSession } from '../sessionStorage.js'

export const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd hook 在关闭/清除期间运行，需要比 TOOL_HOOK_EXECUTION_TIMEOUT_MS
 * 更短的超时时间。此值同时作为单个 hook 的默认超时和整体 AbortSignal 上限
 * （hook 并行运行，因此一个值即可）。可通过环境变量覆盖，以满足需要更多
 * 时间的清理脚本。
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500

export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.ZY_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

/**
 * 检查是否因缺乏工作区信任而应跳过 hook。
 *
 * 所有 hook 都需要工作区信任，因为它们会执行来自 .zy/settings.json 的任意命令。
 * 这是一种纵深防御安全措施。
 *
 * 背景：Hook 通过 captureHooksConfigSnapshot() 在信任对话框显示之前被捕获。
 * 虽然大多数 hook 通过正常程序流在信任建立后才会执行，但对所有 hook 强制
 * 信任检查可以防止：
 * - 未来的 bug 导致 hook 在信任之前意外执行
 * - 任何可能在信任对话框之前触发 hook 的代码路径
 * - 在不受信任的工作区中执行 hook 的安全问题
 *
 * 促成此检查的历史漏洞：
 * - 用户拒绝信任对话框时 SessionEnd hook 仍会执行
 * - 子代理在信任之前完成时 SubagentStop hook 仍会执行
 *
 * @returns 如果应跳过 hook 返回 true，如果应执行返回 false
 */
export function shouldSkipHookDueToTrust(): boolean {
  // 在非交互模式（SDK）下，信任是隐式的——始终执行
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // 在交互模式下，所有 hook 都需要信任
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * 创建所有 hook 类型通用的基础 hook 输入
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // 窄类型声明（非 ToolUseContext），以便调用者可通过结构类型直接传入
  // toolUseContext，而无需本函数依赖 Tool.ts。getAppState 用于读取用户经
  // /effort 设置的 effortValue（存在 AppState，而非 env）。
  agentInfo?: {
    agentId?: string
    agentType?: string
    getAppState?: () => { effortValue?: EffortLevel }
  },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
  effort?: { level: string }
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  // agent_type: 子代理类型（来自 toolUseContext）优先于会话的 --agent 标志。
  // Hook 通过 agent_id 是否存在来区分子代理调用与 --agent 会话中的主线程调用。
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  // effort: 取已含 silent downgrade 的实际档。有 toolUseContext 时读其 AppState
  // 的 effortValue（用户 /effort 设置）；无（生命周期 hook）时按 env/模型默认档解析。
  const effortLevel = getCurrentHookEffortLevel(agentInfo?.getAppState?.().effortValue)
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
    ...(effortLevel && { effort: { level: effortLevel } }),
  }
}
