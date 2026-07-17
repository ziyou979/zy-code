import type { ToolPermissionContext } from '../../tools/tool.js'
import type { PermissionRule } from './permissionRule.js'
import { applyPermissionUpdate } from './permissionUpdate.js'
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

  const updatedContext = applyPermissionUpdate(initialContext, {
    type: 'removeRules',
    rules: [rule.ruleValue],
    behavior: rule.ruleBehavior,
    destination: rule.source as PermissionUpdateDestination,
  })

  switch (rule.source) {
    case 'localSettings':
    case 'userSettings':
    case 'projectSettings':
      // 即使经过 source 分支，TypeScript 仍不会自动缩窄到可编辑设置规则类型。
      deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
      break
    case 'cliArg':
    case 'session':
      break
  }

  setToolPermissionContext(updatedContext)
}
