import * as React from 'react';
import { useCallback } from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import type { PermissionBehavior, PermissionRule, PermissionRuleValue } from '../../../utils/permissions/PermissionRule.js';
import { applyPermissionUpdate, persistPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js';
import { detectUnreachableRules, type UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js';
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js';
import { type EditableSettingSource, SOURCES } from '../../../utils/settings/constants.js';
import { getRelativeSettingsFilePathForSource } from '../../../utils/settings/settings.js';
import { plural } from '../../../utils/stringUtils.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { Dialog } from '../../design-system/Dialog.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
export function optionForPermissionSaveDestination(saveDestination: EditableSettingSource): OptionWithDescription {
  switch (saveDestination) {
    case 'localSettings':
      return {
        label: 'Project settings (local)',
        description: `Saved in ${getRelativeSettingsFilePathForSource('localSettings')}`,
        value: saveDestination
      };
    case 'projectSettings':
      return {
        label: 'Project settings',
        description: `Checked in at ${getRelativeSettingsFilePathForSource('projectSettings')}`,
        value: saveDestination
      };
    case 'userSettings':
      return {
        label: 'User settings',
        description: `Saved in at ~/.zy/settings.json`,
        value: saveDestination
      };
  }
}
type Props = {
  onAddRules: (rules: PermissionRule[], unreachable?: UnreachableRule[]) => void;
  onCancel: () => void;
  ruleValues: PermissionRuleValue[];
  ruleBehavior: PermissionBehavior;
  initialContext: ToolPermissionContext;
  setToolPermissionContext: (newContext: ToolPermissionContext) => void;
};
export function AddPermissionRules({
  onAddRules,
  onCancel,
  ruleValues,
  ruleBehavior,
  initialContext,
  setToolPermissionContext
}: Props) {
  const allOptions = SOURCES.map(optionForPermissionSaveDestination);
  const onSelect = selectedValue => {
    if (selectedValue === "cancel") {
      onCancel();
      return;
    } else {
      if ((SOURCES as readonly string[]).includes(selectedValue)) {
        const destination = selectedValue as EditableSettingSource;
        const updatedContext = applyPermissionUpdate(initialContext, {
          type: "addRules",
          rules: ruleValues,
          behavior: ruleBehavior,
          destination
        });
        persistPermissionUpdate({
          type: "addRules",
          rules: ruleValues,
          behavior: ruleBehavior,
          destination
        });
        setToolPermissionContext(updatedContext);
        const rules = ruleValues.map(ruleValue => ({
          ruleValue,
          ruleBehavior,
          source: destination
        }));
        const sandboxAutoAllowEnabled = SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
        const allUnreachable = detectUnreachableRules(updatedContext, {
          sandboxAutoAllowEnabled
        });
        const newUnreachable = allUnreachable.filter(u => ruleValues.some(rv => rv.toolName === u.rule.ruleValue.toolName && rv.ruleContent === u.rule.ruleValue.ruleContent));
        onAddRules(rules, newUnreachable.length > 0 ? newUnreachable : undefined);
      }
    }
  };
  const t3 = plural(ruleValues.length, "rule");
  const title = `Add ${ruleBehavior} permission ${t3}`;
  const t4 = ruleValues.map(ruleValue_0 => <Box flexDirection="column" key={permissionRuleValueToString(ruleValue_0)}><Text bold={true}>{permissionRuleValueToString(ruleValue_0)}</Text><PermissionRuleDescription ruleValue={ruleValue_0} /></Box>);
  return <Dialog title={title} onCancel={onCancel} color="permission">{<Box flexDirection="column" paddingX={2}>{t4}</Box>}{<Box flexDirection="column" marginY={1}>{<Text>{ruleValues.length === 1 ? "Where should this rule be saved?" : "Where should these rules be saved?"}</Text>}{<Select options={allOptions} onChange={onSelect} />}</Box>}</Dialog>;
}
