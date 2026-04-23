import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { convertEffortValueToLevel, type EffortLevel, getDefaultEffortForModel, modelSupportsEffort, modelSupportsMaxEffort, resolvePickerEffortPersistence, toPersistableEffort } from '../utils/effort.js';
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js';
import { getModelOptions } from '../utils/model/modelOptions.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Pane } from './design-system/Pane.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  /** Overrides the dim header line below "Select model". */
  headerText?: string;
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .zy/settings.json via
   * install.ts) and should not leak to the user's global ~/.zy/settings.
   */
  skipSettingsWrite?: boolean;
};
const NO_PREFERENCE = '__NO_PREFERENCE__';
export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  headerText,
  skipSettingsWrite
}: Props) {
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const [focusedValue, setFocusedValue] = useState(initialValue);
  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(s_0 => s_0.effortValue);
  const t1 = effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined;
  const [effort, setEffort] = useState(t1);
  const modelOptions = getModelOptions();
  let optionsWithInitial;
  if (initial !== null && !modelOptions.some(opt => opt.value === initial)) {
    const t5 = modelDisplayString(initial);
    optionsWithInitial = [...modelOptions, {
      value: initial,
      label: t5,
      description: "Current model"
    }];
  } else {
    optionsWithInitial = modelOptions;
  }
  const selectOptions = optionsWithInitial.map(opt_0 => ({
    ...opt_0,
    value: opt_0.value === null ? NO_PREFERENCE : opt_0.value
  }));
  const initialFocusValue = selectOptions.some(_ => _.value === initialValue) ? initialValue : selectOptions[0]?.value ?? undefined;
  const visibleCount = Math.min(10, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);
  const focusedModelName = selectOptions.find(opt_1 => opt_1.value === focusedValue)?.label;
  const focusedModel = resolveOptionModel(focusedValue);
  const focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
  const focusedSupportsMax = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue);
  const displayEffort = (effort as any) === "max" && !focusedSupportsMax ? "high" : effort;
  const handleFocus = value => {
    setFocusedValue(value);
    if (!hasToggledEffort && effortValue === undefined) {
      setEffort(getDefaultEffortLevelForOption(value));
    }
  };
  const handleCycleEffort = direction => {
    if (!focusedSupportsEffort) {
      return;
    }
    setEffort(prev => cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedSupportsMax));
    setHasToggledEffort(true);
  };
  useKeybindings({
    "modelPicker:decreaseEffort": () => handleCycleEffort("left"),
    "modelPicker:increaseEffort": () => handleCycleEffort("right")
  }, {
    context: "ModelPicker"
  });
  const handleSelect = function handleSelect(value_0) {
    logEvent("zy_model_command_menu_effort", {
      effort: effort as any
    });
    if (!skipSettingsWrite) {
      const effortLevel = resolvePickerEffortPersistence(effort as any, getDefaultEffortLevelForOption(value_0), getSettingsForSource("userSettings")?.effortLevel as any, hasToggledEffort);
      const persistable = toPersistableEffort(effortLevel);
      if (persistable !== undefined) {
        updateSettingsForSource("userSettings", {
          effortLevel: persistable
        });
      }
      setAppState(prev_0 => ({
        ...prev_0,
        effortValue: effortLevel
      }));
    }
    const selectedModel = resolveOptionModel(value_0);
    const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined;
    if (value_0 === NO_PREFERENCE) {
      onSelect(null, selectedEffort);
      return;
    }
    onSelect(value_0, selectedEffort);
  };
  const content = <Box flexDirection="column">{<Box flexDirection="column">{<Box marginBottom={1} flexDirection="column">{<Text color="remember" bold={true}>Select model</Text>}{<Text dimColor={true}>{headerText ?? "Switch between Zy models. Applies to this session and future ZY Code sessions. For other/previous model names, specify with --model."}</Text>}{sessionModel && <Text dimColor={true}>Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model will undo this.</Text>}</Box>}{<Box flexDirection="column" marginBottom={1}>{<Box flexDirection="column"><Select defaultValue={initialValue} defaultFocusValue={initialFocusValue} options={selectOptions} onChange={handleSelect} onFocus={handleFocus} onCancel={onCancel ?? _temp4} visibleOptionCount={visibleCount} /></Box>}{hiddenCount > 0 && <Box paddingLeft={3}><Text dimColor={true}>and {hiddenCount} more…</Text></Box>}</Box>}{<Box marginBottom={1} flexDirection="column">{focusedSupportsEffort ? <Text dimColor={true}><EffortLevelIndicator effort={displayEffort} />{" "}{capitalize(displayEffort)} effort{displayEffort === focusedDefaultEffort ? " (default)" : ""}{" "}<Text color="subtle">← → to adjust</Text></Text> : <Text color="subtle"><EffortLevelIndicator effort={undefined} /> Effort not supported{focusedModelName ? ` for ${focusedModelName}` : ""}</Text>}</Box>}</Box>}{isStandaloneCommand && <Text dimColor={true} italic={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Byline><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" /></Byline>}</Text>}</Box>;
  if (!isStandaloneCommand) {
    return content;
  }
  return <Pane color="permission">{content}</Pane>;
}
function _temp4() {}
function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined;
  return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value);
}
function EffortLevelIndicator({
  effort
}) {
  const t3 = effortLevelToSymbol(effort ?? "low");
  return <Text color={effort ? "zy" : "subtle"}>{t3}</Text>;
}
function cycleEffortLevel(current: EffortLevel, direction: 'left' | 'right', includeMax: boolean): EffortLevel {
  const levels: EffortLevel[] = includeMax ? (['low', 'medium', 'high', 'max'] as any) : ['low', 'medium', 'high'];
  // 如果当前级别不在循环中（例如切换到非 Opus 模型后的 'max'），钳位到 'high'。
  const idx = levels.indexOf(current);
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high');
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!;
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!;
  }
}
function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel();
  const defaultValue = getDefaultEffortForModel(resolved);
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high';
}
