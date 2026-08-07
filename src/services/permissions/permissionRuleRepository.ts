import type { ToolPermissionContext } from '../../tools/tool.js'
import type { PermissionRule } from './permissionRule.js'
import { applyPermissionUpdate } from './permissionUpdate.ts'
import type { PermissionUpdateDestination } from './permissionUpdateSchema.js'
import {
  deletePermissionRuleFromSettings,
  type PermissionRuleFromEditableSettings,
} from './permissionsLoader.js'

type EditPermissionRuleArgs = {
  initialContext: ToolPermissionContext
  setToolPermissionContext: (updatedContext: ToolPermissionContext) => void
}

export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: EditPermissionRuleArgs & { rule: PermissionRule }): Promise<void> {
  if (
    rule.source === 'policySettings' ||
    rule.source === 'flagSettings' ||
    rule.source === 'command'
  ) {
    throw new Error('Cannot delete permission rules from read-only settings')
  }

  // Step 1: 先持久化（仅对可编辑来源），持久化失败时保持内存不变
  if (
    rule.source === 'localSettings' ||
    rule.source === 'userSettings' ||
    rule.source === 'projectSettings'
  ) {
    const success = deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
    if (!success) {
      return // 持久化失败，不更新内存
    }
  }

  // Step 2: 持久化成功后更新内存
  const updatedContext = applyPermissionUpdate(initialContext, {
    type: 'removeRules',
    rules: [rule.ruleValue],
    behavior: rule.ruleBehavior,
    destination: rule.source as PermissionUpdateDestination,
  })

  // Step 3: 同步外部状态
  setToolPermissionContext(updatedContext)
}
