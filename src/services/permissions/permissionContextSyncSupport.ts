import type { ToolPermissionContext } from '../../tool.js'
import type { PermissionBehavior, PermissionRule, PermissionRuleValue } from './permissionRule.js'
import { applyPermissionUpdate, applyPermissionUpdates } from './permissionUpdate.js'
import type { PermissionUpdate, PermissionUpdateDestination } from './permissionUpdateSchema.js'
import { shouldAllowManagedPermissionRulesOnly } from './permissionsLoader.js'

function convertRulesToUpdates(
  rules: PermissionRule[],
  updateType: 'addRules' | 'replaceRules',
): PermissionUpdate[] {
  // 按来源和行为分组规则，避免为同一 source:behavior 生成多条重复更新。
  const grouped = new Map<string, PermissionRuleValue[]>()

  for (const rule of rules) {
    const key = `${rule.source}:${rule.ruleBehavior}`
    const existingRules = grouped.get(key)
    if (existingRules) {
      existingRules.push(rule.ruleValue)
      continue
    }
    grouped.set(key, [rule.ruleValue])
  }

  const updates: PermissionUpdate[] = []
  for (const [key, ruleValues] of grouped) {
    const [source, behavior] = key.split(':')
    updates.push({
      type: updateType,
      rules: ruleValues,
      behavior: behavior as PermissionBehavior,
      destination: source as PermissionUpdateDestination,
    })
  }

  return updates
}

export function applyPermissionRulesToPermissionContext(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  const updates = convertRulesToUpdates(rules, 'addRules')
  return applyPermissionUpdates(toolPermissionContext, updates)
}

function clearRulesForDestinations(
  toolPermissionContext: ToolPermissionContext,
  destinations: PermissionUpdateDestination[],
): ToolPermissionContext {
  let nextContext = toolPermissionContext
  const behaviors: PermissionBehavior[] = ['allow', 'deny', 'ask']

  for (const destination of destinations) {
    for (const behavior of behaviors) {
      nextContext = applyPermissionUpdate(nextContext, {
        type: 'replaceRules',
        rules: [],
        behavior,
        destination,
      })
    }
  }

  return nextContext
}

export function syncPermissionRulesFromDisk(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let context = toolPermissionContext

  // 当仅允许托管规则时，先清空所有非策略来源，避免旧的本地/会话规则继续生效。
  if (shouldAllowManagedPermissionRulesOnly()) {
    context = clearRulesForDestinations(context, [
      'userSettings',
      'projectSettings',
      'localSettings',
      'cliArg',
      'session',
    ])
  }

  // 每次磁盘同步前都清掉磁盘来源，确保“删除某条规则”也能反映到内存上下文。
  context = clearRulesForDestinations(context, ['userSettings', 'projectSettings', 'localSettings'])

  const updates = convertRulesToUpdates(rules, 'replaceRules')
  return applyPermissionUpdates(context, updates)
}
