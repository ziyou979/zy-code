import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands.js';
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
export function FastModePicker(t0) {
  const $ = _c(30);
  const {
    onDone,
    unavailableReason
  } = t0;
  const initialFastMode = useAppState(_temp2);
  const setAppState = useSetAppState();
  const [enableFastMode, setEnableFastMode] = useState(initialFastMode ?? false);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getFastModeRuntimeState();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const runtimeState = t1;
  const isCooldown = runtimeState.status === "cooldown";
  const isUnavailable = unavailableReason !== null;
  const fastModel = getFastModeModel();
  const pricing = fastModel ? (getModelPricingString(fastModel) ?? '') : '';
  let t2;
  if ($[1] !== enableFastMode || $[2] !== isUnavailable || $[3] !== onDone || $[4] !== setAppState) {
    t2 = function handleConfirm() {
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
        setAppState(_temp3);
        onDone("Fast mode OFF");
      }
    };
    $[1] = enableFastMode;
    $[2] = isUnavailable;
    $[3] = onDone;
    $[4] = setAppState;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handleConfirm = t2;
  let t3;
  if ($[7] !== initialFastMode || $[8] !== isUnavailable || $[9] !== onDone || $[10] !== setAppState) {
    t3 = function handleCancel() {
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
    $[7] = initialFastMode;
    $[8] = isUnavailable;
    $[9] = onDone;
    $[10] = setAppState;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  const handleCancel = t3;
  let t5;
  if ($[13] !== isUnavailable) {
    t5 = function handleToggle() {
      if (isUnavailable) {
        return;
      }
      setEnableFastMode(_temp4);
    };
    $[13] = isUnavailable;
    $[14] = t5;
  } else {
    t5 = $[14];
  }
  const handleToggle = t5;
  let t6;
  if ($[15] !== handleConfirm || $[16] !== handleToggle) {
    t6 = {
      "confirm:yes": handleConfirm,
      "confirm:nextField": handleToggle,
      "confirm:next": handleToggle,
      "confirm:previous": handleToggle,
      "confirm:cycleMode": handleToggle,
      "confirm:toggle": handleToggle
    };
    $[15] = handleConfirm;
    $[16] = handleToggle;
    $[17] = t6;
  } else {
    t6 = $[17];
  }
  let t7;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = {
      context: "Confirmation"
    };
    $[18] = t7;
  } else {
    t7 = $[18];
  }
  useKeybindings(t6, t7);
  let t8;
  if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Text><FastIcon cooldown={isCooldown} /> Fast mode (research preview)</Text>;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  const title = t8;
  let t9;
  if ($[20] !== isUnavailable) {
    t9 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : isUnavailable ? <Text>Esc to cancel</Text> : <Text>Tab to toggle · Enter to confirm · Esc to cancel</Text>;
    $[20] = isUnavailable;
    $[21] = t9;
  } else {
    t9 = $[21];
  }
  let t10;
  if ($[22] !== enableFastMode || $[23] !== unavailableReason) {
    t10 = unavailableReason ? <Box marginLeft={2}><Text color="error">{unavailableReason}</Text></Box> : <><Box flexDirection="column" gap={0} marginLeft={2}><Box flexDirection="row" gap={2}><Text bold={true}>Fast mode</Text><Text color={enableFastMode ? "fastMode" : undefined} bold={enableFastMode}>{enableFastMode ? "ON " : "OFF"}</Text><Text dimColor={true}>{pricing}</Text></Box></Box>{isCooldown && runtimeState.status === "cooldown" && <Box marginLeft={2}><Text color="warning">{runtimeState.reason === "overloaded" ? "Fast mode overloaded and is temporarily unavailable" : "You've hit your fast limit"}{" \xB7 resets in "}{formatDuration(runtimeState.resetAt - Date.now(), {
            hideTrailingZeros: true
          })}</Text></Box>}</>;
    $[22] = enableFastMode;
    $[23] = unavailableReason;
    $[24] = t10;
  } else {
    t10 = $[24];
  }
  let t11;
  if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <Text dimColor={true}>Learn more:{" "}<Link url="https://code.zy.com/docs/en/fast-mode">https://code.zy.com/docs/en/fast-mode</Link></Text>;
    $[25] = t11;
  } else {
    t11 = $[25];
  }
  let t12;
  if ($[26] !== handleCancel || $[27] !== t10 || $[28] !== t9) {
    t12 = <Dialog title={title} subtitle={`High-speed mode for improved throughput. Separate rate limits apply.`} onCancel={handleCancel} color="fastMode" inputGuide={t9}>{t10}{t11}</Dialog>;
    $[26] = handleCancel;
    $[27] = t10;
    $[28] = t9;
    $[29] = t12;
  } else {
    t12 = $[29];
  }
  return t12;
}
function _temp4(prev_0) {
  return !prev_0;
}
function _temp3(prev) {
  return {
    ...prev,
    fastMode: false
  };
}
function _temp2(s_0) {
  return s_0.fastMode;
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
    const pricing = fastModel ? (getModelPricingString(fastModel) ?? '') : '';
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
