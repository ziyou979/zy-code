/**
 * SelectEventMode is the entrypoint of the Hooks config menu, where the user
 * sees the list of available hook events.
 *
 * The /hooks menu is read-only: selecting an event lets you browse its
 * configured hooks but not modify them. To add or change hooks, users should
 * edit settings.json directly or ask Zy.
 */

import figures from 'figures';
import * as React from 'react';
import { tSync } from 'src/i18n/index.js';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js';
import { Box, Link, Text } from '../../ink.js';
import { plural } from '../../utils/stringUtils.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '../design-system/Dialog.js';
type Props = {
  hookEventMetadata: Record<HookEvent, HookEventMetadata>;
  hooksByEvent: Partial<Record<HookEvent, number>>;
  totalHooksCount: number;
  restrictedByPolicy: boolean;
  onSelectEvent: (event: HookEvent) => void;
  onCancel: () => void;
};
export function SelectEventMode({
  hookEventMetadata,
  hooksByEvent,
  totalHooksCount,
  restrictedByPolicy,
  onSelectEvent,
  onCancel
}: Props) {
  const t1 = plural(totalHooksCount, "hook");
  const subtitle = tSync('hooks.configuredCount', { count: totalHooksCount, hook: t1 });
  const t5 = Object.entries(hookEventMetadata);
  const t6 = t5.map(t7 => {
    const [name, metadata] = t7;
    const count = hooksByEvent[name as HookEvent] || 0;
    return {
      label: count > 0 ? <Text>{name} <Text color="suggestion">({count})</Text></Text> : name,
      value: name,
      description: metadata.summary
    };
  });
  return <Dialog title={tSync('hooks.title')} subtitle={subtitle} onCancel={onCancel}>{<Box flexDirection="column" gap={1}>{restrictedByPolicy && <Box flexDirection="column"><Text color="suggestion">{figures.info} {tSync('hooks.restrictedByPolicy')}</Text><Text dimColor={true}>{tSync('hooks.restrictedByPolicyDesc')}</Text></Box>}{<Box flexDirection="column"><Text dimColor={true}>{figures.info} {tSync('hooks.readOnlyMenu')}{" "}<Link url="https://code.zy.com/docs/en/hooks">{tSync('hooks.learnMore')}</Link></Text></Box>}{<Box flexDirection="column"><Select onChange={value => {
          onSelectEvent(value as HookEvent);
        }} onCancel={onCancel} options={t6} /></Box>}</Box>}</Dialog>;
}
