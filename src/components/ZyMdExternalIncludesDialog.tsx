import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import type { ExternalzyMdInclude } from '../utils/zymd.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalzyMdInclude[];
};
export function zyMdExternalIncludesDialog({
  onDone,
  isStandaloneDialog,
  externalIncludes
}: Props) {
  React.useEffect(() => {
    logEvent("zy_Zy_md_includes_dialog_shown", {});
  }, []);
  const handleSelection = value => {
    if (value === "no") {
      logEvent("zy_Zy_md_external_includes_dialog_declined", {});
      saveCurrentProjectConfig(current => ({
        ...current,
        haszyMdExternalIncludesApproved: false,
        haszyMdExternalIncludesWarningShown: true
      }));
    } else {
      logEvent("zy_Zy_md_external_includes_dialog_accepted", {});
      saveCurrentProjectConfig(current_0 => ({
        ...current_0,
        haszyMdExternalIncludesApproved: true,
        haszyMdExternalIncludesWarningShown: true
      }));
    }
    onDone();
  };
  const handleEscape = () => {
    handleSelection("no");
  };
  return <Dialog title="Allow external CLAUDE.md file imports?" color="warning" onCancel={handleEscape} hideBorder={!isStandaloneDialog} hideInputGuide={!isStandaloneDialog}>{<Text>This project's CLAUDE.md imports files outside the current working directory. Never allow this for third-party repositories.</Text>}{externalIncludes && externalIncludes.length > 0 && <Box flexDirection="column"><Text dimColor={true}>External imports:</Text>{externalIncludes.map((include, i) => <Text key={i} dimColor={true}>{"  "}{include.path}</Text>)}</Box>}{<Text dimColor={true}>Important: Only use ZY Code with files you trust. Accessing untrusted files may pose security risks{" "}<Link url="https://code.zy.com/docs/en/security" />{" "}</Text>}{<Select options={[{
      label: "Yes, allow external imports",
      value: "yes"
    }, {
      label: "No, disable external imports",
      value: "no"
    }]} onChange={value_0 => handleSelection(value_0 as 'yes' | 'no')} />}</Dialog>;
}
