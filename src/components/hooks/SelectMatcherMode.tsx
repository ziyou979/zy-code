/**
 * SelectMatcherMode shows the configured matchers for a selected hook event.
 *
 * The /hooks menu is read-only: this view no longer offers "add new matcher"
 * and simply lets the user drill into each matcher to see its hooks.
 */
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { Box, Text } from '../../ink.js';
import { type HookSource, hookSourceInlineDisplayString, type IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { plural } from '../../utils/stringUtils.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '../design-system/Dialog.js';
type MatcherWithSource = {
  matcher: string;
  sources: HookSource[];
  hookCount: number;
};
type Props = {
  selectedEvent: HookEvent;
  matchersForSelectedEvent: string[];
  hooksByEventAndMatcher: Record<HookEvent, Record<string, IndividualHookConfig[]>>;
  eventDescription: string;
  onSelect: (matcher: string) => void;
  onCancel: () => void;
};
export function SelectMatcherMode({
  selectedEvent,
  matchersForSelectedEvent,
  hooksByEventAndMatcher,
  eventDescription,
  onSelect,
  onCancel
}: Props) {
  const matchersWithSources = matchersForSelectedEvent.map(matcher => {
    const hooks = hooksByEventAndMatcher[selectedEvent]?.[matcher] || [];
    const sources = Array.from(new Set(hooks.map(h => h.source)));
    return {
      matcher,
      sources,
      hookCount: hooks.length
    };
  });
  if (matchersForSelectedEvent.length === 0) {
    return <Dialog title={`${selectedEvent} - Matchers`} subtitle={eventDescription} onCancel={onCancel} inputGuide={() => <Text>Esc to go back</Text>}>{<Box flexDirection="column" gap={1}><Text dimColor={true}>No hooks configured for this event.</Text><Text dimColor={true}>To add hooks, edit settings.json directly or ask Zy.</Text></Box>}</Dialog>;
  }
  const t3 = matchersWithSources.map(item => {
    const sourceText = item.sources.map(hookSourceInlineDisplayString).join(", ");
    const matcherLabel = item.matcher || "(all)";
    return {
      label: `[${sourceText}] ${matcherLabel}`,
      value: item.matcher,
      description: `${item.hookCount} ${plural(item.hookCount, "hook")}`
    };
  });
  return <Dialog title={`${selectedEvent} - Matchers`} subtitle={eventDescription} onCancel={onCancel}>{<Box flexDirection="column"><Select options={t3} onChange={value => {
        onSelect(value);
      }} onCancel={onCancel} /></Box>}</Dialog>;
}
