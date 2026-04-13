import * as React from 'react';
import { useState } from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { FastIcon, getFastIconString } from '../../components/FastIcon.js';
import { Box, Link, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { type AppState, useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { clearFastModeCooldown, getFastModeModel, getFastModeRuntimeState, getFastModeUnavailableReason, isFastModeEnabled } from '../../utils/fastMode.js';
import { formatDuration } from '../../utils/format.js';
import { getModelPricingString } from '../../utils/modelCost.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
function applyFastMode(enable: boolean, setAppState: (f: (prev: AppState) => AppState) => void): void {
  clearFastModeCooldown();
  updateSettingsForSource('userSettings', {
    fastMode: enable ? true : undefined
  });
  const fastModel = getFastModeModel();
  if (enable && fastModel) {
    setAppState(prev => ({
      ...prev,
      mainLoopModelForSession: fastModel,
      fastMode: true
    }));
  } else {
    setAppState(prev => ({
      ...prev,
      mainLoopModelForSession: null,
      fastMode: false
    }));
  }
}
export function FastModePicker({
  onDone,
  unavailableReason
}) {
  const initialFastMode = useAppState(s_0 => s_0.fastMode);
  const setAppState = useSetAppState();
  const [enableFastMode, setEnableFastMode] = useState(initialFastMode ?? false);
  const runtimeState = getFastModeRuntimeState();
  const isCooldown = runtimeState.status === "cooldown";
  const isUnavailable = unavailableReason !== null;
  const fastModel = getFastModeModel();
  const pricing = fastModel ? getModelPricingString(fastModel) ?? '' : '';
  const handleConfirm = function handleConfirm() {
    if (isUnavailable) {
      return;
    }
    applyFastMode(enableFastMode, setAppState);
    logEvent("tengu_fast_mode_toggled", {
      enabled: enableFastMode,
      source: "picker" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    if (enableFastMode) {
      const fastIcon = getFastIconString(enableFastMode);
      onDone(`${fastIcon} Fast mode ON · ${pricing}`);
    } else {
      setAppState(prev => ({
        ...prev,
        fastMode: false
      }));
      onDone("Fast mode OFF");
    }
  };
  const handleCancel = function handleCancel() {
    if (isUnavailable) {
      if (initialFastMode) {
        applyFastMode(false, setAppState);
      }
      onDone("Fast mode OFF", {
        display: "system"
      });
      return;
    }
    const message = initialFastMode ? `${getFastIconString()} Kept Fast mode ON` : "Kept Fast mode OFF";
    onDone(message, {
      display: "system"
    });
  };
  const handleToggle = function handleToggle() {
    if (isUnavailable) {
      return;
    }
    setEnableFastMode(prev_0 => !prev_0);
  };
  useKeybindings({
    "confirm:yes": handleConfirm,
    "confirm:nextField": handleToggle,
    "confirm:next": handleToggle,
    "confirm:previous": handleToggle,
    "confirm:cycleMode": handleToggle,
    "confirm:toggle": handleToggle
  }, {
    context: "Confirmation"
  });
  const title = <Text><FastIcon cooldown={isCooldown} /> Fast mode (research preview)</Text>;
  return <Dialog title={title} subtitle={`High-speed mode for improved throughput. Separate rate limits apply.`} onCancel={handleCancel} color="fastMode" inputGuide={exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : isUnavailable ? <Text>Esc to cancel</Text> : <Text>Tab to toggle · Enter to confirm · Esc to cancel</Text>}>{unavailableReason ? <Box marginLeft={2}><Text color="error">{unavailableReason}</Text></Box> : <><Box flexDirection="column" gap={0} marginLeft={2}><Box flexDirection="row" gap={2}><Text bold={true}>Fast mode</Text><Text color={enableFastMode ? "fastMode" : undefined} bold={enableFastMode}>{enableFastMode ? "ON " : "OFF"}</Text><Text dimColor={true}>{pricing}</Text></Box></Box>{isCooldown && runtimeState.status === "cooldown" && <Box marginLeft={2}><Text color="warning">{runtimeState.reason === "overloaded" ? "Fast mode overloaded and is temporarily unavailable" : "You've hit your fast limit"}{" \xB7 resets in "}{formatDuration(runtimeState.resetAt - Date.now(), {
            hideTrailingZeros: true
          })}</Text></Box>}</>}{<Text dimColor={true}>Learn more:{" "}<Link url="https://code.zy.com/docs/en/fast-mode">https://code.zy.com/docs/en/fast-mode</Link></Text>}</Dialog>;
}
async function handleFastModeShortcut(enable: boolean, getAppState: () => AppState, setAppState: (f: (prev: AppState) => AppState) => void): Promise<string> {
  const unavailableReason = getFastModeUnavailableReason();
  if (unavailableReason) {
    return `Fast mode unavailable: ${unavailableReason}`;
  }
  applyFastMode(enable, setAppState);
  logEvent('tengu_fast_mode_toggled', {
    enabled: enable,
    source: 'shortcut' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  if (enable) {
    const fastIcon = getFastIconString(true);
    const fastModel = getFastModeModel();
    const pricing = fastModel ? getModelPricingString(fastModel) ?? '' : '';
    return `${fastIcon} Fast mode ON · ${pricing}`;
  } else {
    return `Fast mode OFF`;
  }
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode | null> {
  if (!isFastModeEnabled()) {
    return null;
  }
  const arg = args?.trim().toLowerCase();
  if (arg === 'on' || arg === 'off') {
    const result = await handleFastModeShortcut(arg === 'on', context.getAppState, context.setAppState);
    onDone(result);
    return null;
  }
  const unavailableReason = getFastModeUnavailableReason();
  logEvent('tengu_fast_mode_picker_shown', {
    unavailable_reason: (unavailableReason ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  return <FastModePicker onDone={onDone} unavailableReason={unavailableReason} />;
}
