import React from 'react';
import { Box, Link, Text } from '../ink.js';
import { tSync } from 'src/i18n/index.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  onDone: () => void;
};
export function CostThresholdDialog({
  onDone
}: Props) {
  return <Dialog title={tSync('costThreshold.title')} onCancel={onDone}>{<Box flexDirection="column"><Text>{tSync('costThreshold.learnMore')}</Text><Link url="https://code.zy.com/docs/en/costs" /></Box>}{<Select options={[{
      value: "ok",
      label: tSync('costThreshold.gotIt')
    }]} onChange={onDone} />}</Dialog>;
}
