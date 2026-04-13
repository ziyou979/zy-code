import React from 'react';
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
  return <T0 color={"warning"} titleColor={"warning"} title={"Managed settings require approval"}>{<T1 flexDirection={"column"} gap={1} paddingTop={1}>{<Text>Your organization has configured managed settings that could allow execution of arbitrary code or interception of your prompts and responses.</Text>}{<T2 flexDirection={"column"}>{<Text dimColor={true}>Settings requiring approval:</Text>}{t12}</T2>}{<Text>Only accept if you trust your organization's IT administration and expect these settings to be configured.</Text>}{<Select options={[{
        label: "Yes, I trust these settings",
        value: "accept"
      }, {
        label: "No, exit ZY Code",
        value: "exit"
      }]} onChange={value_0 => onChange(value_0 as 'accept' | 'exit')} onCancel={() => onChange("exit")} />}{<Text dimColor={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to confirm · Esc to exit</>}</Text>}</T1>}</T0>;
}
