/**
 * Shared utilities for displaying agent information.
 * Used by both the CLI `zy agents` handler and the interactive `/agents` command.
 */

import { getDefaultSubagentModel } from '../../services/model/agent.js'
import { getSourceDisplayName, type SettingSource } from '../../utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * Ordered list of agent source groups for display.
 * Both the CLI and interactive UI should use this to ensure consistent ordering.
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
 * Annotate agents with override information by comparing against the active
 * (winning) agent list. An agent is "overridden" when another agent with the
 * same type from a higher-priority source takes precedence.
 *
 * Also deduplicates by (agentType, source) to handle git worktree duplicates
 * where the same agent file is loaded from both the worktree and main repo.
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

  // Iterate allAgents, annotating each with override info from activeAgents.
  // Deduplicate by (agentType, source) to handle git worktree duplicates.
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
 * Resolve the display model string for an agent.
 * Returns the model alias or 'inherit' for display purposes.
 */
export function resolveAgentModelDisplay(agent: AgentDefinition): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) {
    return undefined
  }
  return model === 'inherit' ? 'inherit' : model
}

/**
 * Get a human-readable label for the source that overrides an agent.
 * Returns lowercase, e.g. "user", "project", "managed".
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * Compare agents alphabetically by name (case-insensitive).
 */
export function compareAgentsByName(a: AgentDefinition, b: AgentDefinition): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
