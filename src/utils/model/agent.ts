import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import {
  parseUserSpecifiedModel,
} from './model.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  if (process.env.ZY_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.ZY_CODE_SUBAGENT_MODEL)
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    return parentModel
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  return parseUserSpecifiedModel(agentModelWithExp)
}

/**
 * Check if a tier alias (advanced/standard/compact) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a user on a custom advanced-tier model (via /model) who
 * spawns a subagent with `model: advanced` should get that same advanced model, not whatever
 * getDefaultAdvancedModel() returns.
 * See https://github.com/anthropics/zy-code/issues/30815.
 *
 * Only bare tier aliases match. `advanced[1m]`, `best` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const m = parentModel.toLowerCase()
  switch (alias.toLowerCase()) {
    case 'advanced':
      return m.includes('advanced')
    case 'standard':
      return m.includes('standard')
    case 'compact':
      return m.includes('compact')
    default:
      return false
  }
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'standard',
      label: 'Standard',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'advanced',
      label: 'Advanced',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'compact',
      label: 'Compact',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
