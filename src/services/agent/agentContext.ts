/**
 * 使用 AsyncLocalStorage 进行分析归因的 Agent 上下文。
 *
 * 此模块提供了一种在无需参数下钻的情况下跨异步操作
 * 跟踪 agent 身份的方法。支持两种 agent 类型：
 *
 * 1. 子 Agent (Agent 工具)：在进程内运行，用于快速委托任务。
 *    上下文：SubagentContext，agentType 为 'subagent'
 *
 * 2. 进程内队友：属于蜂群的一部分，具有团队协调功能。
 *    上下文：TeammateAgentContext，agentType 为 'teammate'
 *
 * 对于在独立进程中的蜂群队友 (tmux/iTerm2)，请改用环境
 * 变量：ZY_CODE_AGENT_ID, ZY_CODE_PARENT_SESSION_ID
 *
 * 为什么用 AsyncLocalStorage（而非 AppState）：
 * 当 Agent 被后台运行 (ctrl+b) 时，多个 Agent 可在同一进程
 * 中并发运行。AppState 是单一共享状态，会被覆盖，导致
 * Agent A 的事件错误使用 Agent B 的上下文。
 * AsyncLocalStorage 隔离每个异步执行链，使并发 Agent
 * 互不干扰。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/index.js'
import { isAgentSwarmsEnabled } from '../swarm/agentSwarmsEnabled.js'

/**
 * 子 Agent (Agent 工具 Agent) 的上下文。
 * 子 Agent 在进程内运行，用于快速委托任务。
 */
export type SubagentContext = {
  /** The subagent's UUID (from createAgentId()) */
  agentId: string
  /** The team lead's session ID (from ZY_CODE_PARENT_SESSION_ID env var), undefined for main REPL subagents */
  parentSessionId?: string
  /** Agent type - 'subagent' for Agent tool agents */
  agentType: 'subagent'
  /** The subagent's type name (e.g., "Explore", "Bash", "code-reviewer") */
  subagentName?: string
  /** Whether this is a built-in agent (vs user-defined custom agent) */
  isBuiltIn?: boolean
  /** The request_id in the invoking agent that spawned or resumed this agent.
   *  For nested subagents this is the immediate invoker, not the root —
   *  session_id already bundles the whole tree. Updated on each resume. */
  invokingRequestId?: string
  /** Whether this invocation is the initial spawn or a subsequent resume
   *  via SendMessage. Undefined when invokingRequestId is absent. */
  invocationKind?: 'spawn' | 'resume'
  /** Mutable flag: has this invocation's edge been emitted to telemetry yet?
   *  Reset to false on each spawn/resume; flipped true by
   *  consumeInvokingRequestId() on the first terminal API event. */
  invocationEmitted?: boolean
}

/**
 * 进程内队友的上下文。
 * 队友属于蜂群并具有团队协调功能。
 */
export type TeammateAgentContext = {
  /** Full agent ID, e.g., "researcher@my-team" */
  agentId: string
  /** Display name, e.g., "researcher" */
  agentName: string
  /** Team name this teammate belongs to */
  teamName: string
  /** UI color assigned to this teammate */
  agentColor?: string
  /** Whether teammate must enter plan mode before implementing */
  planModeRequired: boolean
  /** The team lead's session ID for transcript correlation */
  parentSessionId: string
  /** Whether this agent is the team lead */
  isTeamLead: boolean
  /** Agent type - 'teammate' for swarm teammates */
  agentType: 'teammate'
  /** The request_id in the invoking agent that spawned or resumed this
   *  teammate. Undefined for teammates started outside a tool call
   *  (e.g. session start). Updated on each resume. */
  invokingRequestId?: string
  /** See SubagentContext.invocationKind. */
  invocationKind?: 'spawn' | 'resume'
  /** Mutable flag: see SubagentContext.invocationEmitted. */
  invocationEmitted?: boolean
}

/**
 * Agent 上下文的判别联合类型。
 * 使用 agentType 区分 subagent 和 teammate 上下文。
 */
export type AgentContext = SubagentContext | TeammateAgentContext

const agentContextStorage = new AsyncLocalStorage<AgentContext>()

/**
 * 获取当前 Agent 上下文（若存在）。
 * 如果不在 Agent 上下文中运行（子 Agent 或队友），返回 undefined。
 * 使用类型守卫 isSubagentContext() 或 isTeammateAgentContext() 来缩小类型。
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}

/**
 * 使用给定的 Agent 上下文运行异步函数。
 * 函数内的所有异步操作都将有权访问此上下文。
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}

/**
 * 类型守卫：检查上下文是否为 SubagentContext。
 */
export function isSubagentContext(context: AgentContext | undefined): context is SubagentContext {
  return context?.agentType === 'subagent'
}

/**
 * 类型守卫：检查上下文是否为 TeammateAgentContext。
 */
export function isTeammateAgentContext(
  context: AgentContext | undefined,
): context is TeammateAgentContext {
  if (isAgentSwarmsEnabled()) {
    return context?.agentType === 'teammate'
  }
  return false
}

/**
 * 获取适合分析日志记录的子 Agent 名称。
 * 内置 Agent 返回类型名称，自定义 Agent 返回 "user-defined"，
 * 若不在子 Agent 上下文中则返回 undefined。
 *
 * 适用于分析元数据：内置 Agent 名称是代码常量，
 * 自定义 Agent 始终映射为字面量 "user-defined"。
 */
export function getSubagentLogName():
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  const context = getAgentContext()
  if (!isSubagentContext(context) || !context.subagentName) {
    return undefined
  }
  return (
    context.isBuiltIn ? context.subagentName : 'user-defined'
  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 获取当前 Agent 上下文的调用 request_id —— 每次调用仅一次。
 * 在 spawn/resume 后的首次调用时返回 id，随后直到下一次边界
 * 前返回 undefined。主线程上或 spawn 路径无 request_id 时也返回 undefined。
 *
 * 稀疏边语义：invokingRequestId 仅出现在每次调用的一个
 * zy_api_success/error 上，因此下游非 NULL 值标记 spawn/resume 边界。
 */
export function consumeInvokingRequestId():
  | {
      invokingRequestId: string
      invocationKind: 'spawn' | 'resume' | undefined
    }
  | undefined {
  const context = getAgentContext()
  if (!context?.invokingRequestId || context.invocationEmitted) {
    return undefined
  }
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    invocationKind: context.invocationKind,
  }
}
