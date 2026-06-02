import capitalize from 'lodash-es/capitalize.js'
import { useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../services/model/model.js'
import { getModelOptions } from '../services/model/modelOptions.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  clampEffort,
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  getModelEffortLevels,
  modelSupportsEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  /** Overrides the dim header line below "Select model". */
  headerText?: string
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .zy/settings.json via
   * install.ts) and should not leak to the user's global ~/.zy/settings.
   */
  skipSettingsWrite?: boolean
}
const NO_PREFERENCE = '__NO_PREFERENCE__'
export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  headerText,
  skipSettingsWrite,
}: Props) {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const initialValue = initial === null ? NO_PREFERENCE : initial
  const [focusedValue, setFocusedValue] = useState(initialValue)
  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState((s) => s.effortValue)
  const initialEffort =
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined
  const [effort, setEffort] = useState(initialEffort)
  const modelOptions = getModelOptions()
  let optionsWithInitial
  if (initial !== null && !modelOptions.some((opt) => opt.value === initial)) {
    const initialModelDisplay = modelDisplayString(initial)
    optionsWithInitial = [
      ...modelOptions,
      {
        value: initial,
        label: initialModelDisplay,
        description: 'Current model',
      },
    ]
  } else {
    optionsWithInitial = modelOptions
  }
  const selectOptions = optionsWithInitial.map((option) => ({
    ...option,
    value: option.value === null ? NO_PREFERENCE : option.value,
  }))
  const initialFocusValue = selectOptions.some((_) => _.value === initialValue)
    ? initialValue
    : (selectOptions[0]?.value ?? undefined)
  const visibleCount = Math.min(10, selectOptions.length)
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount)
  const focusedModelName = selectOptions.find((option) => option.value === focusedValue)?.label
  const focusedModel = resolveOptionModel(focusedValue)
  const focusedLevels = focusedModel ? getModelEffortLevels(focusedModel) : []
  const focusedSupportsEffort = focusedLevels.length > 0
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue)
  // 将当前选择 clamp 到聚焦模型支持的档位(例如从支持 max 的模型切到不支持的模型)。
  const displayEffort =
    effort && focusedLevels.length > 0 ? (clampEffort(effort, focusedLevels) ?? effort) : effort
  const handleFocus = (value) => {
    setFocusedValue(value)
    if (!hasToggledEffort && effortValue === undefined) {
      setEffort(getDefaultEffortLevelForOption(value))
    }
  }
  const handleCycleEffort = (direction) => {
    if (!focusedSupportsEffort) {
      return
    }
    setEffort((prev) => cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedLevels))
    setHasToggledEffort(true)
  }
  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
    },
    {
      context: 'ModelPicker',
    },
  )
  const handleSelect = function handleSelect(selectedValue) {
    logEvent('zy_model_command_menu_effort', {
      effort: effort as any,
    })
    if (!skipSettingsWrite) {
      const effortLevel = resolvePickerEffortPersistence(
        effort as any,
        getDefaultEffortLevelForOption(selectedValue),
        getSettingsForSource('userSettings')?.effortLevel as any,
        hasToggledEffort,
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', {
          effortLevel: persistable,
        })
      }
      setAppState((prev) => ({
        ...prev,
        effortValue: effortLevel,
      }))
    }
    const selectedModel = resolveOptionModel(selectedValue)
    const selectedEffort =
      hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined
    if (selectedValue === NO_PREFERENCE) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(selectedValue, selectedEffort)
  }
  const content = (
    <Box flexDirection="column">
      {
        <Box flexDirection="column">
          {
            <Box marginBottom={1} flexDirection="column">
              {
                <Text color="remember" bold={true}>
                  Select model
                </Text>
              }
              {
                <Text dimColor={true}>
                  {headerText ??
                    'Switch between Zy models. Applies to this session and future ZY Code sessions. For other/previous model names, specify with --model.'}
                </Text>
              }
              {sessionModel && (
                <Text dimColor={true}>
                  Currently using {modelDisplayString(sessionModel)} for this session (set by plan
                  mode). Selecting a model will undo this.
                </Text>
              )}
            </Box>
          }
          {
            <Box flexDirection="column" marginBottom={1}>
              {
                <Box flexDirection="column">
                  <Select
                    defaultValue={initialValue}
                    defaultFocusValue={initialFocusValue}
                    options={selectOptions}
                    onChange={handleSelect}
                    onFocus={handleFocus}
                    onCancel={onCancel ?? _temp4}
                    visibleOptionCount={visibleCount}
                  />
                </Box>
              }
              {hiddenCount > 0 && (
                <Box paddingLeft={3}>
                  <Text dimColor={true}>and {hiddenCount} more…</Text>
                </Box>
              )}
            </Box>
          }
          {
            <Box marginBottom={1} flexDirection="column">
              {focusedSupportsEffort ? (
                <Text dimColor={true}>
                  <EffortLevelIndicator effort={displayEffort} /> {capitalize(displayEffort)} effort
                  {displayEffort === focusedDefaultEffort ? ' (default)' : ''}{' '}
                  <Text color="subtle">← → to adjust</Text>
                </Text>
              ) : (
                <Text color="subtle">
                  <EffortLevelIndicator effort={undefined} /> Effort not supported
                  {focusedModelName ? ` for ${focusedModelName}` : ''}
                </Text>
              )}
            </Box>
          }
        </Box>
      }
      {isStandaloneCommand && (
        <Text dimColor={true} italic={true}>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="select:cancel"
                context="Select"
                fallback="Esc"
                description="exit"
              />
            </Byline>
          )}
        </Text>
      )}
    </Box>
  )
  if (!isStandaloneCommand) {
    return content
  }
  return <Pane color="permission">{content}</Pane>
}
function _temp4() {}
function resolveOptionModel(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value)
}
function EffortLevelIndicator({ effort }) {
  const effortSymbol = effortLevelToSymbol(effort ?? 'low')
  return <Text color={effort ? 'zy' : 'subtle'}>{effortSymbol}</Text>
}
function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  levels: readonly EffortLevel[],
): EffortLevel {
  if (levels.length === 0) {
    return current
  }
  // 如果当前级别不在该模型支持的档位中（例如切换模型后），钳位到最接近的合法档。
  const idx = levels.indexOf(current)
  const currentIndex = idx !== -1 ? idx : Math.max(0, levels.indexOf(clampEffort(current, levels)!))
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!
  }
}
function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
  const defaultValue = getDefaultEffortForModel(resolved)
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'thorough'
}
