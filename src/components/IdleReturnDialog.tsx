import React from 'react';
import { Box, Text } from '../ink.js';
import { tSync } from '../i18n/index.js';
import { formatTokens } from '../utils/format.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never';
type Props = {
  idleMinutes: number;
  totalInputTokens: number;
  onDone: (action: IdleReturnAction) => void;
};
export function IdleReturnDialog({
  idleMinutes,
  totalInputTokens,
  onDone
}: Props) {
  const formattedIdle = formatIdleDuration(idleMinutes);
  const formattedTokens = formatTokens(totalInputTokens);
  return <Dialog title={`You've been away ${formattedIdle} and this conversation is ${formattedTokens} tokens.`} onCancel={() => onDone("dismiss")}>{<Box flexDirection="column"><Text>{tSync('idleReturn.description')}</Text></Box>}{<Select options={[{
      value: "continue" as const,
      label: tSync('idleReturn.continue')
    }, {
      value: "clear" as const,
      label: tSync('idleReturn.newConversation')
    }, {
      value: "never" as const,
      label: tSync('idleReturn.neverAsk')
    }]} onChange={value => onDone(value)} />}</Dialog>;
}
function formatIdleDuration(minutes: number): string {
  if (minutes < 1) {
    return '< 1m';
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}
