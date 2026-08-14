/**
 * 展示 agent 信息的共享工具。
 * 供 CLI `zy agents` handler 和交互式 `/agents` 命令共同使用。
 */

import { getDefaultSubagentModel } from '../../services/model/agent.js'
import { getSourceDisplayName, type SettingSource } from '../../services/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * 用于显示的 agent 来源分组有序列表。
 * CLI 和交互式 UI 都应使用该列表，以确保顺序一致。
 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: 'agents.source.userSettings', source: 'userSettings' },
  { label: 'agents.source.projectSettings', source: 'projectSettings' },
  { label: 'agents.source.localSettings', source: 'localSettings' },
  { label: 'agents.source.policySettings', source: 'policySettings' },
  { label: 'agents.source.plugin', source: 'plugin' },
  { label: 'agents.source.flagSettings', source: 'flagSettings' },
  { label: 'agents.source.builtIn', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/**
 * 通过与当前生效的 agent 列表对比，为 agent 标注覆盖信息。当更高优先级来源中
 * 存在同类型 agent 并优先生效时，当前 agent 被视为“已覆盖”。
 *
 * 同时按 (agentType, source) 去重，处理同一 agent 文件同时从 git worktree 和主仓库
 * 加载而导致的重复。
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // 遍历 allAgents，用 activeAgents 中的覆盖信息逐个标注。
  // 按 (agentType, source) 去重，处理 git worktree 重复项。
  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy = active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * 解析 agent 的 model 显示字符串。
 * 返回 model 别名，或用于显示的 'inherit'。
 */
export function resolveAgentModelDisplay(agent: AgentDefinition): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) {
    return undefined
  }
  return model === 'inherit' ? 'inherit' : model
}

/**
 * 获取覆盖 agent 的来源所对应的易读标签。
 * 返回小写形式，如 "user"、"project"、"managed"。
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * 按名称字母顺序比较 agent，忽略大小写。
 */
export function compareAgentsByName(a: AgentDefinition, b: AgentDefinition): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
