import React from 'react';
import { tSync } from 'src/i18n/index.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { SettingsJson } from '../../utils/settings/types.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import { extractDangerousSettings, formatDangerousSettingsList } from './utils.js';
type Props = {
  settings: SettingsJson;
  onAccept: () => void;
  onReject: () => void;
};
export function ManagedSettingsSecurityDialog({
  settings,
  onAccept,
  onReject
}: Props) {
  const dangerous = extractDangerousSettings(settings);
  const settingsList = formatDangerousSettingsList(dangerous);
  const exitState = useExitOnCtrlCDWithKeybindings();
  useKeybinding("confirm:no", onReject, {
    context: "Confirmation"
  });
  const onChange = function onChange(value) {
    if (value === "exit") {
      onReject();
      return;
    }
    onAccept();
  };
  const T0 = PermissionDialog;
  const T1 = Box;
  const T2 = Box;
  const t12 = settingsList.map((item, index) => <Box key={index} paddingLeft={2}><Text><Text dimColor={true}>· </Text><Text>{item}</Text></Text></Box>);
  return <T0 color={"warning"} titleColor={"warning"} title={tSync('managedSettings.requireApproval')}>{<T1 flexDirection={"column"} gap={1} paddingTop={1}>{<Text>{tSync('managedSettings.orgConfiguredWarning')}</Text>}{<T2 flexDirection={"column"}>{<Text dimColor={true}>{tSync('managedSettings.requiringApproval')}</Text>}{t12}</T2>}{<Text>{tSync('managedSettings.onlyAcceptIfTrust')}</Text>}{<Select options={[{
        label: tSync('managedSettings.yesTrust'),
        value: "accept"
      }, {
        label: tSync('managedSettings.noExit'),
        value: "exit"
      }]} onChange={value_0 => onChange(value_0 as 'accept' | 'exit')} onCancel={() => onChange("exit")} />}{<Text dimColor={true}>{exitState.pending ? <>{tSync('managedSettings.pressAgainToExit', { keyName: exitState.keyName })}</> : <>{tSync('managedSettings.enterConfirmEscExit')}</>}</Text>}</T1>}</T0>;
}
