import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { useAppState, useAppStateStore } from 'src/state/AppState.js'
import type { HookEvent } from 'src/types'
import type { CommandResultDisplay } from '../../commands.js'
import { useSettingsChange } from '../../hooks/useSettingsChange.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  getHookEventMetadata,
  getHooksForMatcher,
  getMatcherMetadata,
  getSortedMatchersForEvent,
  groupHooksByEventAndMatcher,
} from '../../utils/hooks/hooksConfigManager.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { SelectEventMode } from './SelectEventMode.js'
import { SelectHookMode } from './SelectHookMode.js'
import { SelectMatcherMode } from './SelectMatcherMode.js'
import { ViewHookMode } from './ViewHookMode.js'

type Props = {
  toolNames: string[]
  onExit: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
type ModeState =
  | {
      mode: 'select-event'
    }
  | {
      mode: 'select-matcher'
      event: HookEvent
    }
  | {
      mode: 'select-hook'
      event: HookEvent
      matcher: string
    }
  | {
      mode: 'view-hook'
      event: HookEvent
      hook: IndividualHookConfig
    }
export function HooksConfigMenu({ toolNames, onExit }: Props) {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'select-event',
  })
  const [disabledByPolicy, setDisabledByPolicy] = useState(() => {
    const settings = getInitialSettings()
    const hooksDisabled = settings?.disableAllHooks === true
    return hooksDisabled && getSettingsForSource('policySettings')?.disableAllHooks === true
  })
  const [restrictedByPolicy, setRestrictedByPolicy] = useState(
    () => getSettingsForSource('policySettings')?.allowManagedHooksOnly === true,
  )
  useSettingsChange((source) => {
    if (source === 'policySettings') {
      const settings_0 = getInitialSettings()
      const hooksDisabled_0 = settings_0?.disableAllHooks === true
      setDisabledByPolicy(
        hooksDisabled_0 && getSettingsForSource('policySettings')?.disableAllHooks === true,
      )
      setRestrictedByPolicy(getSettingsForSource('policySettings')?.allowManagedHooksOnly === true)
    }
  })
  const mode = modeState.mode
  const selectedEvent = 'event' in modeState ? modeState.event : 'PreToolUse'
  const selectedMatcher = 'matcher' in modeState ? modeState.matcher : null
  const mcp = useAppState((s) => s.mcp)
  const appStateStore = useAppStateStore()
  const combinedToolNames = [...toolNames, ...mcp.tools.map((tool) => tool.name)]
  const hooksByEventAndMatcher = groupHooksByEventAndMatcher(
    appStateStore.getState(),
    combinedToolNames,
  )
  const sortedMatchersForSelectedEvent = getSortedMatchersForEvent(
    hooksByEventAndMatcher,
    selectedEvent,
  )
  const _hooksForSelectedMatcher = getHooksForMatcher(
    hooksByEventAndMatcher,
    selectedEvent,
    selectedMatcher,
  )
  const handleExit = () => {
    onExit(tSync('hooks.dialogDismissed'), {
      display: 'system',
    })
  }
  useKeybinding('confirm:no', handleExit, {
    context: 'Confirmation',
    isActive: mode === 'select-event',
  })
  useKeybinding(
    'confirm:no',
    () => {
      setModeState({
        mode: 'select-event',
      })
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-matcher',
    },
  )
  useKeybinding(
    'confirm:no',
    () => {
      if ('event' in modeState) {
        if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
          setModeState({
            mode: 'select-matcher',
            event: modeState.event,
          })
        } else {
          setModeState({
            mode: 'select-event',
          })
        }
      }
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-hook',
    },
  )
  useKeybinding(
    'confirm:no',
    () => {
      if (modeState.mode === 'view-hook') {
        const { event, hook } = modeState
        setModeState({
          mode: 'select-hook',
          event,
          matcher: hook.matcher || '',
        })
      }
    },
    {
      context: 'Confirmation',
      isActive: mode === 'view-hook',
    },
  )
  const hookEventMetadata = getHookEventMetadata(combinedToolNames)
  const settings_1 = getInitialSettings()
  const hooksDisabled_1 = settings_1?.disableAllHooks === true
  const byEvent: Record<string, number> = {}
  let total = 0
  for (const [event_0, matchers] of Object.entries(hooksByEventAndMatcher)) {
    const eventCount = Object.values(matchers).reduce((sum, hooks) => sum + hooks.length, 0)
    byEvent[event_0 as HookEvent] = eventCount
    total = total + eventCount
  }
  const { hooksByEvent, totalHooksCount } = {
    hooksByEvent: byEvent,
    totalHooksCount: total,
  }
  if (hooksDisabled_1) {
    const pluralResult = plural(totalHooksCount, 'hook')
    const pluralResult2 = plural(totalHooksCount, 'is', 'are')
    return (
      <Dialog
        title={tSync('hooks.configDisabled')}
        onCancel={handleExit}
        inputGuide={() => <Text>{tSync('hooks.escToClose')}</Text>}
      >
        {
          <Box flexDirection="column" gap={1}>
            {
              <Box flexDirection="column">
                {
                  <Text>
                    {tSync('hooks.allHooksDisabled')}
                    {disabledByPolicy && tSync('hooks.byManagedSettings')}.{' '}
                    {tSync('hooks.configuredHooksNotRunning', {
                      count: totalHooksCount,
                      hook: pluralResult,
                      verb: pluralResult2,
                    })}
                  </Text>
                }
                {
                  <Box marginTop={1}>
                    <Text dimColor={true}>{tSync('hooks.whenDisabled')}</Text>
                  </Box>
                }
                {<Text dimColor={true}>{tSync('hooks.noHookCommands')}</Text>}
                {<Text dimColor={true}>{tSync('hooks.noStatusLine')}</Text>}
                {<Text dimColor={true}>{tSync('hooks.noHookValidation')}</Text>}
              </Box>
            }
            {!disabledByPolicy && (
              <Text dimColor={true}>{tSync('hooks.reenableInstructions')}</Text>
            )}
          </Box>
        }
      </Dialog>
    )
  }
  switch (modeState.mode) {
    case 'select-event': {
      const handleSelectEvent = (event_2: string) => {
        const hookEvent = event_2 as HookEvent
        if (getMatcherMetadata(hookEvent, combinedToolNames) !== undefined) {
          setModeState({
            mode: 'select-matcher',
            event: hookEvent,
          })
        } else {
          setModeState({
            mode: 'select-hook',
            event: hookEvent,
            matcher: '',
          })
        }
      }
      let eventMode
      eventMode = (
        <SelectEventMode
          hookEventMetadata={hookEventMetadata}
          hooksByEvent={hooksByEvent}
          totalHooksCount={totalHooksCount}
          restrictedByPolicy={restrictedByPolicy}
          onSelectEvent={handleSelectEvent}
          onCancel={handleExit}
        />
      )
      return eventMode
    }
    case 'select-matcher': {
      const eventMetadata = hookEventMetadata[modeState.event]
      const handleSelectMatcher = (matcher: string) => {
        setModeState({
          mode: 'select-hook',
          event: modeState.event,
          matcher,
        })
      }
      const handleBackToEvents = () => {
        setModeState({
          mode: 'select-event',
        })
      }
      let matcherMode
      matcherMode = (
        <SelectMatcherMode
          selectedEvent={modeState.event}
          eventDescription={eventMetadata.description}
          matchersForSelectedEvent={sortedMatchersForSelectedEvent}
          hooksByEventAndMatcher={hooksByEventAndMatcher}
          onSelect={handleSelectMatcher}
          onCancel={handleBackToEvents}
        />
      )
      return matcherMode
    }
    case 'select-hook': {
      const eventMetadata_0 = hookEventMetadata[modeState.event]
      const hooksForMatcher = getHooksForMatcher(
        hooksByEventAndMatcher,
        modeState.event,
        modeState.matcher,
      )
      const handleSelectHook = (hook: IndividualHookConfig) => {
        setModeState({
          mode: 'view-hook',
          event: modeState.event,
          hook,
        })
      }
      const handleBackToMatchers = () => {
        if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
          setModeState({
            mode: 'select-matcher',
            event: modeState.event,
          })
        } else {
          setModeState({
            mode: 'select-event',
          })
        }
      }
      let hookMode
      hookMode = (
        <SelectHookMode
          selectedEvent={modeState.event}
          selectedMatcher={modeState.matcher}
          hooksForSelectedMatcher={hooksForMatcher}
          hookEventMetadata={eventMetadata_0}
          onSelect={handleSelectHook}
          onCancel={handleBackToMatchers}
        />
      )
      return hookMode
    }
    case 'view-hook': {
      const handleBackToHooks = () => {
        setModeState({
          mode: 'select-hook',
          event: modeState.hook.event,
          matcher: modeState.hook.matcher || '',
        })
      }
      let viewHookMode
      viewHookMode = (
        <ViewHookMode
          selectedHook={modeState.hook}
          eventSupportsMatcher={
            getMatcherMetadata(modeState.hook.event, combinedToolNames) !== undefined
          }
          onCancel={handleBackToHooks}
        />
      )
      return viewHookMode
    }
  }
}
