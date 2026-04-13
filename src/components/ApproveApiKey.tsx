import React from 'react';
import { Text } from '../ink.js';
import { saveGlobalConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  customApiKeyTruncated: string;
  onDone(approved: boolean): void;
};
export function ApproveApiKey({
  customApiKeyTruncated,
  onDone
}: Props) {
  const onChange = function onChange(value) {
    switch (value) {
      case "yes":
        {
          saveGlobalConfig(current_0 => ({
            ...current_0,
            customApiKeyResponses: {
              ...current_0.customApiKeyResponses,
              approved: [...(current_0.customApiKeyResponses?.approved ?? []), customApiKeyTruncated]
            }
          }));
          onDone(true);
          break;
        }
      case "no":
        {
          saveGlobalConfig(current => ({
            ...current,
            customApiKeyResponses: {
              ...current.customApiKeyResponses,
              rejected: [...(current.customApiKeyResponses?.rejected ?? []), customApiKeyTruncated]
            }
          }));
          onDone(false);
        }
    }
  };
  return <Dialog title="Detected a custom API key in your environment" color="warning" onCancel={() => onChange("no")}>{<Text>{<Text bold={true}>ZY_API_KEY</Text>}<Text>: sk-ant-...{customApiKeyTruncated}</Text></Text>}{<Text>Do you want to use this API key?</Text>}{<Select defaultValue="no" defaultFocusValue="no" options={[{
      label: "Yes",
      value: "yes"
    }, {
      label: <Text>No (<Text bold={true}>recommended</Text>)</Text>,
      value: "no"
    }]} onChange={value_0 => onChange(value_0 as 'yes' | 'no')} onCancel={() => onChange("no")} />}</Dialog>;
}
