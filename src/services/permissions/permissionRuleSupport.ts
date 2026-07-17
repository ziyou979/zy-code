import { extractOutputRedirections } from 'src/shell-eval/bash/commands.js'
import type { Tool, ToolPermissionContext } from '../../tools/tool.js'
import { getSettingSourceDisplayNameLowercase, SETTING_SOURCES } from '../settings/constants.js'
import { plural } from '../../utils/stringUtils.js'
import { getToolNameForPermissionCheck, mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import { permissionModeTitle } from './permissionMode.js'
import type { PermissionDecisionReason } from './permissionResult.js'
import type { PermissionBehavior, PermissionRule, PermissionRuleSource } from './permissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  'cliArg',
  'command',
  'session',
] as const satisfies readonly PermissionRuleSource[]

export function permissionRuleSourceDisplayString(source: PermissionRuleSource): string {
  return getSettingSourceDisplayNameLowercase(source)
}

function getRulesByBehavior(
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const rawRulesBySource =
    behavior === 'allow'
      ? context.alwaysAllowRules
      : behavior === 'deny'
        ? context.alwaysDenyRules
        : context.alwaysAskRules

  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (rawRulesBySource[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: behavior,
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getAllowRules(context: ToolPermissionContext): PermissionRule[] {
  return getRulesByBehavior(context, 'allow')
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (decisionReason) {
    if (decisionReason.type === 'classifier') {
      return `Classifier '${decisionReason.classifier}' requires approval for this ${toolName} command: ${decisionReason.reason}`
    }
    switch (decisionReason.type) {
      case 'hook':
        return decisionReason.reason
          ? `Hook '${decisionReason.hookName}' blocked this action: ${decisionReason.reason}`
          : `Hook '${decisionReason.hookName}' requires approval for this ${toolName} command`
      case 'rule': {
        const ruleString = permissionRuleValueToString(decisionReason.rule.ruleValue)
        const sourceString = permissionRuleSourceDisplayString(decisionReason.rule.source)
        return `Permission rule '${ruleString}' from ${sourceString} requires approval for this ${toolName} command`
      }
      case 'subcommandResults': {
        const needsApproval: string[] = []
        for (const [command, result] of decisionReason.reasons) {
          if (result.behavior === 'ask' || result.behavior === 'passthrough') {
            if (toolName === 'Bash') {
              const { commandWithoutRedirections, redirections } =
                extractOutputRedirections(command)
              needsApproval.push(redirections.length > 0 ? commandWithoutRedirections : command)
            } else {
              needsApproval.push(command)
            }
          }
        }
        if (needsApproval.length > 0) {
          const countValue = needsApproval.length
          return `This ${toolName} command contains multiple operations. The following ${plural(countValue, 'part')} ${plural(countValue, 'requires', 'require')} approval: ${needsApproval.join(', ')}`
        }
        return `This ${toolName} command contains multiple operations that require approval`
      }
      case 'permissionPromptTool':
        return `Tool '${decisionReason.permissionPromptToolName}' requires approval for this ${toolName} command`
      case 'sandboxOverride':
        return 'Run outside of the sandbox'
      case 'workingDir':
      case 'safetyCheck':
      case 'other':
      case 'asyncAgent':
        return decisionReason.reason
      case 'mode':
        return `Current permission mode (${permissionModeTitle(decisionReason.mode)}) requires approval for this ${toolName} command`
    }
  }

  return `ZY requested permissions to use ${toolName}, but you haven't granted it yet.`
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return getRulesByBehavior(context, 'deny')
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return getRulesByBehavior(context, 'ask')
}

function toolMatchesRule(tool: Pick<Tool, 'name' | 'mcpInfo'>, rule: PermissionRule): boolean {
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  const nameForRuleMatch = getToolNameForPermissionCheck(tool)
  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAllowRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getDenyRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAskRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return (
    getDenyRules(context).find(
      (rule) =>
        rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent === agentType,
    ) || null
  )
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  const deniedAgentTypes = new Set<string>()
  for (const rule of getDenyRules(context)) {
    if (rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent !== undefined) {
      deniedAgentTypes.add(rule.ruleValue.ruleContent)
    }
  }
  return agents.filter((agent) => !deniedAgentTypes.has(agent.agentType))
}

export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(context, getToolNameForPermissionCheck(tool), behavior)
}

export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  const rules = getRulesByBehavior(context, behavior)
  for (const rule of rules) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}
