/**
 * HooksConfigMenu is a read-only browser for configured hooks.
 *
 * Users can drill into each hook event, see configured matchers and hooks
 * (of any type: command, prompt, agent, http), and view individual hook
 * details. To add or modify hooks, users should edit settings.json directly
 * or ask Zy — the menu directs them there.
 *
 * The menu is read-only because the old editing UI only supported
 * command-type hooks and duplicating the settings.json editing surface
 * in-menu for all four types would be a maintenance burden.
 */
import * as React from 'react';
import { useState } from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useSettingsChange } from '../../hooks/useSettingsChange.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getHookEventMetadata, getHooksForMatcher, getMatcherMetadata, getSortedMatchersForEvent, groupHooksByEventAndMatcher } from '../../utils/hooks/hooksConfigManager.js';
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { getSettings_DEPRECATED, getSettingsForSource } from '../../utils/settings/settings.js';
import { plural } from '../../utils/stringUtils.js';
import { Dialog } from '../design-system/Dialog.js';
import { SelectEventMode } from './SelectEventMode.js';
import { SelectHookMode } from './SelectHookMode.js';
import { SelectMatcherMode } from './SelectMatcherMode.js';
import { ViewHookMode } from './ViewHookMode.js';
type Props = {
  toolNames: string[];
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type ModeState = {
  mode: 'select-event';
} | {
  mode: 'select-matcher';
  event: HookEvent;
} | {
  mode: 'select-hook';
  event: HookEvent;
  matcher: string;
} | {
  mode: 'view-hook';
  event: HookEvent;
  hook: IndividualHookConfig;
};
export function HooksConfigMenu({
  toolNames,
  onExit
}: Props) {
  const [modeState, setModeState] = useState({
    mode: "select-event"
  });
  const [disabledByPolicy, setDisabledByPolicy] = useState(() => {
    const settings = getSettings_DEPRECATED();
    const hooksDisabled = settings?.disableAllHooks === true;
    return hooksDisabled && getSettingsForSource("policySettings")?.disableAllHooks === true;
  });
  const [restrictedByPolicy, setRestrictedByPolicy] = useState(() => getSettingsForSource("policySettings")?.allowManagedHooksOnly === true);
  useSettingsChange((source) => {
    if (source === "policySettings") {
      const settings_0 = getSettings_DEPRECATED();
      const hooksDisabled_0 = settings_0?.disableAllHooks === true;
      setDisabledByPolicy(hooksDisabled_0 && getSettingsForSource("policySettings")?.disableAllHooks === true);
      setRestrictedByPolicy(getSettingsForSource("policySettings")?.allowManagedHooksOnly === true);
    }
  });
  const mode = modeState.mode;
  const selectedEvent = "event" in modeState ? modeState.event : "PreToolUse";
  const selectedMatcher = "matcher" in modeState ? modeState.matcher : null;
  const mcp = useAppState((s) => s.mcp);
  const appStateStore = useAppStateStore();
  const combinedToolNames = [...toolNames, ...mcp.tools.map((tool) => tool.name)];
  const hooksByEventAndMatcher = groupHooksByEventAndMatcher(appStateStore.getState(), combinedToolNames);
  const sortedMatchersForSelectedEvent = getSortedMatchersForEvent(hooksByEventAndMatcher, selectedEvent);
  const hooksForSelectedMatcher = getHooksForMatcher(hooksByEventAndMatcher, selectedEvent, selectedMatcher);
  const handleExit = () => {
    onExit("Hooks dialog dismissed", {
      display: "system"
    });
  };
  useKeybinding("confirm:no", handleExit, {
    context: "Confirmation",
    isActive: mode === "select-event"
  });
  useKeybinding("confirm:no", () => {
    setModeState({
      mode: "select-event"
    });
  }, {
    context: "Confirmation",
    isActive: mode === "select-matcher"
  });
  useKeybinding("confirm:no", () => {
    if ("event" in modeState) {
      if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
        setModeState({
          mode: "select-matcher",
          event: modeState.event
        });
      } else {
        setModeState({
          mode: "select-event"
        });
      }
    }
  }, {
    context: "Confirmation",
    isActive: mode === "select-hook"
  });
  useKeybinding("confirm:no", () => {
    if (modeState.mode === "view-hook") {
      const {
        event,
        hook
      } = modeState;
      setModeState({
        mode: "select-hook",
        event,
        matcher: hook.matcher || ""
      });
    }
  }, {
    context: "Confirmation",
    isActive: mode === "view-hook"
  });
  const hookEventMetadata = getHookEventMetadata(combinedToolNames);
  const settings_1 = getSettings_DEPRECATED();
  const hooksDisabled_1 = settings_1?.disableAllHooks === true;
  const byEvent = {};
  let total = 0;
  for (const [event_0, matchers] of Object.entries(hooksByEventAndMatcher)) {
    const eventCount = Object.values(matchers).reduce((sum, hooks) => sum + hooks.length, 0);
    byEvent[event_0 as HookEvent] = eventCount;
    total = total + eventCount;
  }
  const {
    hooksByEvent,
    totalHooksCount
  } = {
    hooksByEvent: byEvent,
    totalHooksCount: total
  };
  if (hooksDisabled_1) {
    const pluralResult = plural(totalHooksCount, "hook");
    const pluralResult2 = plural(totalHooksCount, "is", "are");
    return <Dialog title="Hook Configuration - Disabled" onCancel={handleExit} inputGuide={() => <Text>Esc to close</Text>}>{<Box flexDirection="column" gap={1}>{<Box flexDirection="column">{<Text>All hooks are currently {<Text bold={true}>disabled</Text>}{disabledByPolicy && " by a managed settings file"}. You have{" "}{<Text bold={true}>{totalHooksCount}</Text>} configured{" "}{pluralResult} that{" "}{pluralResult2} not running.</Text>}{<Box marginTop={1}><Text dimColor={true}>When hooks are disabled:</Text></Box>}{<Text dimColor={true}>· No hook commands will execute</Text>}{<Text dimColor={true}>· StatusLine will not be displayed</Text>}{<Text dimColor={true}>· Tool operations will proceed without hook validation</Text>}</Box>}{!disabledByPolicy && <Text dimColor={true}>To re-enable hooks, remove "disableAllHooks" from settings.json or ask Zy.</Text>}</Box>}</Dialog>;
  }
  switch (modeState.mode) {
    case "select-event":
      {
        let t21;
        t21 = (event_2) => {
          if (getMatcherMetadata(event_2, combinedToolNames) !== undefined) {
            setModeState({
              mode: "select-matcher",
              event: event_2
            });
          } else {
            setModeState({
              mode: "select-hook",
              event: event_2,
              matcher: ""
            });
          }
        };
        let t22;
        t22 = <SelectEventMode hookEventMetadata={hookEventMetadata} hooksByEvent={hooksByEvent} totalHooksCount={totalHooksCount} restrictedByPolicy={restrictedByPolicy} onSelectEvent={t21} onCancel={handleExit} />;
        return t22;
      }
    case "select-matcher":
      {
        const t21 = hookEventMetadata[modeState.event];
        let t22;
        t22 = (matcher) => {
          setModeState({
            mode: "select-hook",
            event: modeState.event,
            matcher
          });
        };
        let t23;
        t23 = () => {
          setModeState({
            mode: "select-event"
          });
        };
        let pluralResult;
        pluralResult = <SelectMatcherMode selectedEvent={modeState.event} matchersForSelectedEvent={sortedMatchersForSelectedEvent} hooksByEventAndMatcher={hooksByEventAndMatcher} eventDescription={t21.description} onSelect={t22} onCancel={t23} />;
        return pluralResult;
      }
    case "select-hook":
      {
        const t21 = hookEventMetadata[modeState.event];
        let t22;
        t22 = (hook_1) => {
          setModeState({
            mode: "view-hook",
            event: modeState.event,
            hook: hook_1
          });
        };
        let t23;
        t23 = () => {
          if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
            setModeState({
              mode: "select-matcher",
              event: modeState.event
            });
          } else {
            setModeState({
              mode: "select-event"
            });
          }
        };
        let pluralResult;
        pluralResult = <SelectHookMode selectedEvent={modeState.event} selectedMatcher={modeState.matcher} hooksForSelectedMatcher={hooksForSelectedMatcher} hookEventMetadata={t21} onSelect={t22} onCancel={t23} />;
        return pluralResult;
      }
    case "view-hook":
      {
        const t21 = modeState.hook;
        let t22;
        t22 = getMatcherMetadata(modeState.event, combinedToolNames);
        const t23 = t22 !== undefined;
        let pluralResult;
        pluralResult = () => {
          const {
            event: event_1,
            hook: hook_0
          } = modeState;
          setModeState({
            mode: "select-hook",
            event: event_1,
            matcher: hook_0.matcher || ""
          });
        };
        let pluralResult2;
        pluralResult2 = <ViewHookMode selectedHook={t21} eventSupportsMatcher={t23} onCancel={pluralResult} />;
        return pluralResult2;
      }
  }
}