import type { Tools } from '../../Tool.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { tSync } from '../../i18n/index.js'
import { getAgentSourceDisplayName } from './utils.js'

export type AgentValidationResult = {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

export function validateAgentType(agentType: string): string | null {
  if (!agentType) {
    return tSync('agents.validation.typeRequired')
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(agentType)) {
    return tSync('agents.validation.typeFormat')
  }

  if (agentType.length < 3) {
    return tSync('agents.validation.typeMinLength')
  }

  if (agentType.length > 50) {
    return tSync('agents.validation.typeMaxLength')
  }

  return null
}

export function validateAgent(
  agent: Omit<CustomAgentDefinition, 'location'>,
  availableTools: Tools,
  existingAgents: AgentDefinition[],
): AgentValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 验证 agent 类型
  if (!agent.agentType) {
    errors.push(tSync('agents.validation.typeRequired'))
  } else {
    const typeError = validateAgentType(agent.agentType)
    if (typeError) {
      errors.push(typeError)
    }

    // 检查重复（编辑时排除自身）
    const duplicate = existingAgents.find(
      a => a.agentType === agent.agentType && a.source !== agent.source,
    )
    if (duplicate) {
      errors.push(
        tSync('agents.validation.typeDuplicate', {
          name: agent.agentType,
          source: getAgentSourceDisplayName(duplicate.source),
        }),
      )
    }
  }

  // 验证描述
  if (!agent.whenToUse) {
    errors.push(tSync('agents.validation.descriptionRequired'))
  } else if (agent.whenToUse.length < 10) {
    warnings.push(tSync('agents.validation.descriptionTooShort'))
  } else if (agent.whenToUse.length > 5000) {
    warnings.push(tSync('agents.validation.descriptionTooLong'))
  }

  // 验证工具
  if (agent.tools !== undefined && !Array.isArray(agent.tools)) {
    errors.push(tSync('agents.validation.toolsInvalid'))
  } else {
    if (agent.tools === undefined) {
      warnings.push(tSync('agents.validation.toolsAllWarning'))
    } else if (agent.tools.length === 0) {
      warnings.push(tSync('agents.validation.toolsNoneWarning'))
    }

    // 检查无效工具
    const resolvedTools = resolveAgentTools(agent, availableTools, false)

    if (resolvedTools.invalidTools.length > 0) {
      errors.push(
        tSync('agents.validation.toolsInvalidList', {
          tools: resolvedTools.invalidTools.join(', '),
        }),
      )
    }
  }

  // 验证系统提示
  const systemPrompt = agent.getSystemPrompt()
  if (!systemPrompt) {
    errors.push(tSync('agents.validation.promptRequired'))
  } else if (systemPrompt.length < 20) {
    errors.push(tSync('agents.validation.promptTooShort'))
  } else if (systemPrompt.length > 10000) {
    warnings.push(tSync('agents.validation.promptTooLong'))
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  }
}
