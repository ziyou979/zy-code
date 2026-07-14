import { tSync } from 'src/i18n/index.js'
import type { HookEvent } from 'src/types/index.js'
import type { HookEventMetadata } from 'src/services/hooks/hooksConfigManager.js'
import { Box, Text } from '../../ink.js'
import {
  getHookDisplayText,
  hookSourceHeaderDisplayString,
  type IndividualHookConfig,
} from '../../services/hooks/hooksSettings.js'
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
            onChange={(value: string) => {
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
