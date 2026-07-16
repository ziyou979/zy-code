import { tSync } from 'src/i18n/index.js'
import { Select } from '../../CustomSelect/select.js'
import { Box, Text } from '../../../ink.js'
import { SandboxManager } from '../../../services/sandbox/sandbox-adapter.js'
import type { ToolPermissionContext } from '../../../tools/Tool.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../../../services/permissions/permissionRule.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../../services/permissions/permissionUpdate.js'
import { permissionRuleValueToString } from '../../../services/permissions/permissionRuleParser.js'
import {
  detectUnreachableRules,
  type UnreachableRule,
} from '../../../services/permissions/shadowedRuleDetection.js'
import { type EditableSettingSource, SOURCES } from '../../../services/settings/constants.js'
import { getRelativeSettingsFilePathForSource } from '../../../services/settings/settings.js'
import { plural } from '../../../utils/stringUtils.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { Dialog } from '../../design-system/Dialog.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'
export function optionForPermissionSaveDestination(
  saveDestination: EditableSettingSource,
): OptionWithDescription {
  switch (saveDestination) {
    case 'localSettings':
      return {
        label: tSync('permissionRules.projectSettingsLocal'),
        description: tSync('permissionRules.savedIn', {
          path: getRelativeSettingsFilePathForSource('localSettings'),
        }),
        value: saveDestination,
      }
    case 'projectSettings':
      return {
        label: tSync('permissionRules.projectSettings'),
        description: tSync('permissionRules.checkedInAt', {
          path: getRelativeSettingsFilePathForSource('projectSettings'),
        }),
        value: saveDestination,
      }
    case 'userSettings':
      return {
        label: tSync('permissionRules.userSettings'),
        description: tSync('permissionRules.savedInAtUser'),
        value: saveDestination,
      }
  }
}
type Props = {
  onAddRules: (rules: PermissionRule[], unreachable?: UnreachableRule[]) => void
  onCancel: () => void
  ruleValues: PermissionRuleValue[]
  ruleBehavior: PermissionBehavior
  initialContext: ToolPermissionContext
  setToolPermissionContext: (newContext: ToolPermissionContext) => void
}
export function AddPermissionRules({
  onAddRules,
  onCancel,
  ruleValues,
  ruleBehavior,
  initialContext,
  setToolPermissionContext,
}: Props) {
  const allOptions = SOURCES.map(optionForPermissionSaveDestination)
  const onSelect = (selectedValue: string) => {
    if (selectedValue === 'cancel') {
      onCancel()
      return
    } else {
      if ((SOURCES as readonly string[]).includes(selectedValue)) {
        const destination = selectedValue as EditableSettingSource
        const updatedContext = applyPermissionUpdate(initialContext, {
          type: 'addRules',
          rules: ruleValues,
          behavior: ruleBehavior,
          destination,
        })
        persistPermissionUpdate({
          type: 'addRules',
          rules: ruleValues,
          behavior: ruleBehavior,
          destination,
        })
        setToolPermissionContext(updatedContext)
        const rules = ruleValues.map((ruleValue) => ({
          ruleValue,
          ruleBehavior,
          source: destination,
        }))
        const sandboxAutoAllowEnabled =
          SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled()
        const allUnreachable = detectUnreachableRules(updatedContext, {
          sandboxAutoAllowEnabled,
        })
        const newUnreachable = allUnreachable.filter((u) =>
          ruleValues.some(
            (rv) =>
              rv.toolName === u.rule.ruleValue.toolName &&
              rv.ruleContent === u.rule.ruleValue.ruleContent,
          ),
        )
        onAddRules(rules, newUnreachable.length > 0 ? newUnreachable : undefined)
      }
    }
  }
  const ruleCountText = plural(ruleValues.length, 'rule')
  const title = tSync('permissionRules.addPermissionRuleTitle', {
    behavior: ruleBehavior,
    ruleCount: ruleCountText,
  })
  const ruleDescriptions = ruleValues.map((ruleValue) => (
    <Box flexDirection="column" key={permissionRuleValueToString(ruleValue)}>
      <Text bold={true}>{permissionRuleValueToString(ruleValue)}</Text>
      <PermissionRuleDescription ruleValue={ruleValue} />
    </Box>
  ))
  return (
    <Dialog title={title} onCancel={onCancel} color="permission">
      {
        <Box flexDirection="column" paddingX={2}>
          {ruleDescriptions}
        </Box>
      }
      {
        <Box flexDirection="column" marginY={1}>
          {
            <Text>
              {ruleValues.length === 1
                ? tSync('permissionRules.whereSaveSingleRule')
                : tSync('permissionRules.whereSaveMultipleRules')}
            </Text>
          }
          {<Select options={allOptions} onChange={onSelect} />}
        </Box>
      }
    </Dialog>
  )
}
