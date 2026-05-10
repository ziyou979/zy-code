/**
 * SelectHookMode shows all hooks configured for a given event+matcher pair.
 *
 * The /hooks menu is read-only: this view no longer offers "add new hook"
 * and selecting a hook shows its read-only details instead of a delete
 * confirmation.
 */
import * as React from 'react'
import { tSync } from 'src/i18n/index.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js'
import { Box, Text } from '../../ink.js'
import {
  getHookDisplayText,
  hookSourceHeaderDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'
type Props = {
  selectedEvent: HookEvent
  selectedMatcher: string | null
  hooksForSelectedMatcher: IndividualHookConfig[]
  hookEventMetadata: HookEventMetadata
  onSelect: (hook: IndividualHookConfig) => void
  onCancel: () => void
}
export function SelectHookMode({
  selectedEvent,
  selectedMatcher,
  hooksForSelectedMatcher,
  hookEventMetadata,
  onSelect,
  onCancel,
}: Props) {
  const title =
    hookEventMetadata.matcherMetadata !== undefined
      ? `${selectedEvent} - Matcher: ${selectedMatcher || '(all)'}`
      : selectedEvent
  if (hooksForSelectedMatcher.length === 0) {
    return (
      <Dialog
        title={title}
        subtitle={hookEventMetadata.description}
        onCancel={onCancel}
        inputGuide={() => <Text>{tSync('hooks.escToGoBack')}</Text>}
      >
        {
          <Box flexDirection="column" gap={1}>
            <Text dimColor={true}>{tSync('hooks.noHooksForEvent')}</Text>
            <Text dimColor={true}>{tSync('hooks.editToAddHooks')}</Text>
          </Box>
        }
      </Dialog>
    )
  }
  const hookOptions = hooksForSelectedMatcher.map((hook, index) => ({
    label: `[${hook.config.type}] ${getHookDisplayText(hook.config)}`,
    value: index.toString(),
    description:
      hook.source === 'pluginHook' && hook.pluginName
        ? `${hookSourceHeaderDisplayString(hook.source)} (${hook.pluginName})`
        : hookSourceHeaderDisplayString(hook.source),
  }))
  return (
    <Dialog title={title} subtitle={hookEventMetadata.description} onCancel={onCancel}>
      {
        <Box flexDirection="column">
          <Select
            options={hookOptions}
            onChange={(value) => {
              const index_0 = parseInt(value, 10)
              const hook_0 = hooksForSelectedMatcher[index_0]
              if (hook_0) {
                onSelect(hook_0)
              }
            }}
            onCancel={onCancel}
          />
        </Box>
      }
    </Dialog>
  )
}
