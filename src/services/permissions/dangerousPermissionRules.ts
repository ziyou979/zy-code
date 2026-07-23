import { relative } from 'node:path'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { getCwd } from '../environment/cwd.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import type { ToolPermissionRulesBySource } from '../../types/permissions.js'
import type { SettingSource } from '../settings/constants.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { CROSS_PLATFORM_CODE_EXEC, DANGEROUS_BASH_PATTERNS } from './dangerousPatterns.js'
import type { PermissionRule, PermissionRuleSource, PermissionRuleValue } from './permissionRule.js'
import { type AdditionalWorkingDirectory, applyPermissionUpdate } from './permissionUpdate.js'
import type { PermissionUpdateDestination } from './permissionUpdateSchema.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

const permLog = createDebugLog('permissions')

export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== BASH_TOOL_NAME) {
    return false
  }
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()
  if (content === '*') {
    return true
  }

  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const lowerPattern = pattern.toLowerCase()
    if (content === lowerPattern) {
      return true
    }
    if (content === `${lowerPattern}:*`) {
      return true
    }
    if (content === `${lowerPattern}*`) {
      return true
    }
    if (content === `${lowerPattern} *`) {
      return true
    }
    if (content.startsWith(`${lowerPattern} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) {
    return false
  }
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()
  if (content === '*') {
    return true
  }

  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    'pwsh',
    'powershell',
    'cmd',
    'wsl',
    'iex',
    'invoke-expression',
    'icm',
    'invoke-command',
    'start-process',
    'saps',
    'start',
    'start-job',
    'sajb',
    'start-threadjob',
    'register-objectevent',
    'register-engineevent',
    'register-wmievent',
    'register-scheduledjob',
    'new-pssession',
    'nsn',
    'enter-pssession',
    'etsn',
    'add-type',
    'new-object',
  ]

  for (const pattern of patterns) {
    if (content === pattern) {
      return true
    }
    if (content === `${pattern}:*`) {
      return true
    }
    if (content === `${pattern}*`) {
      return true
    }
    if (content === `${pattern} *`) {
      return true
    }
    if (content.startsWith(`${pattern} -`) && content.endsWith('*')) {
      return true
    }

    const sp = pattern.indexOf(' ')
    const exe = sp === -1 ? `${pattern}.exe` : `${pattern.slice(0, sp)}.exe${pattern.slice(sp)}`
    if (content === exe) {
      return true
    }
    if (content === `${exe}:*`) {
      return true
    }
    if (content === `${exe}*`) {
      return true
    }
    if (content === `${exe} *`) {
      return true
    }
    if (content.startsWith(`${exe} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

export function isDangerousTaskPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}

function formatPermissionSource(source: PermissionRuleSource): string {
  if ((SETTING_SOURCES as readonly string[]).includes(source)) {
    const filePath = getSettingsFilePathForSource(source as SettingSource)
    if (filePath) {
      const relativePath = relative(getCwd(), filePath)
      return relativePath.length < filePath.length ? relativePath : filePath
    }
  }
  return source
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  ruleDisplay: string
  sourceDisplay: string
}

function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (isInternalBuild() && toolName === 'Tmux') {
    return true
  }
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent)
  )
}

export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isDangerousClassifierPermission(rule.ruleValue.toolName, rule.ruleValue.ruleContent)
    ) {
      const ruleString = rule.ruleValue.ruleContent
        ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : `${rule.ruleValue.toolName}(*)`
      dangerous.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: ruleString,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const match = toolSpec.match(/^([^(]+)(?:\(([^)]*)\))?$/)
    if (!match) {
      continue
    }
    const toolName = match[1]!.trim()
    const ruleContent = match[2]?.trim()
    if (isDangerousClassifierPermission(toolName, ruleContent)) {
      dangerous.push({
        ruleValue: { toolName, ruleContent },
        source: 'cliArg',
        ruleDisplay: ruleContent ? toolSpec : `${toolName}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return dangerous
}

export function isOverlyBroadBashAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === BASH_TOOL_NAME && ruleValue.ruleContent === undefined
}

export function isOverlyBroadPowerShellAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === POWERSHELL_TOOL_NAME && ruleValue.ruleContent === undefined
}

export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (rule.ruleBehavior === 'allow' && isOverlyBroadBashAllowRule(rule.ruleValue)) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadBashAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

export function findOverlyBroadPowerShellPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (rule.ruleBehavior === 'allow' && isOverlyBroadPowerShellAllowRule(rule.ruleValue)) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadPowerShellAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

function isPermissionUpdateDestination(
  source: PermissionRuleSource,
): source is PermissionUpdateDestination {
  return ['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'].includes(source)
}

export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  const rulesBySource = new Map<PermissionUpdateDestination, PermissionRuleValue[]>()
  for (const permission of dangerousPermissions) {
    if (!isPermissionUpdateDestination(permission.source)) {
      continue
    }
    const existingRules = rulesBySource.get(permission.source)
    if (existingRules) {
      existingRules.push(permission.ruleValue)
      continue
    }
    rulesBySource.set(permission.source, [permission.ruleValue])
  }

  let updatedContext = context
  for (const [destination, rules] of rulesBySource) {
    updatedContext = applyPermissionUpdate(updatedContext, {
      type: 'removeRules',
      rules,
      behavior: 'allow',
      destination,
    })
  }

  return updatedContext
}

export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const rules: PermissionRule[] = []
  for (const [source, ruleStrings] of Object.entries(context.alwaysAllowRules)) {
    if (!ruleStrings) {
      continue
    }
    for (const ruleString of ruleStrings) {
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(ruleString),
      })
    }
  }

  const dangerousPermissions = findDangerousClassifierPermissions(rules, [])
  if (dangerousPermissions.length === 0) {
    return {
      ...context,
      strippedDangerousRules: context.strippedDangerousRules ?? {},
    }
  }

  for (const permission of dangerousPermissions) {
    permLog(
      `Ignoring dangerous permission ${permission.ruleDisplay} from ${permission.sourceDisplay} (bypasses classifier)`,
    )
  }

  const stripped: ToolPermissionRulesBySource = {}
  for (const permission of dangerousPermissions) {
    if (!isPermissionUpdateDestination(permission.source)) {
      continue
    }
    ;(stripped[permission.source] ??= []).push(permissionRuleValueToString(permission.ruleValue))
  }

  return {
    ...removeDangerousPermissions(context, dangerousPermissions),
    strippedDangerousRules: stripped,
  }
}

export function restoreDangerousPermissions(context: ToolPermissionContext): ToolPermissionContext {
  const stash = context.strippedDangerousRules
  if (!stash) {
    return context
  }

  let result = context
  for (const [source, ruleStrings] of Object.entries(stash)) {
    if (!ruleStrings || ruleStrings.length === 0) {
      continue
    }
    result = applyPermissionUpdate(result, {
      type: 'addRules',
      rules: ruleStrings.map(permissionRuleValueFromString),
      behavior: 'allow',
      destination: source as PermissionUpdateDestination,
    })
  }

  return { ...result, strippedDangerousRules: undefined }
}
