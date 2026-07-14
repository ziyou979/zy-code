/**
 * SelectEventMode is the entrypoint of the Hooks config menu, where the user
 * sees the list of available hook events.
 *
 * The /hooks menu is read-only: selecting an event lets you browse its
 * configured hooks but not modify them. To add or change hooks, users should
 * edit settings.json directly or ask Zy.
 */

import { tSync } from 'src/i18n/index.js'
import type { HookEvent } from 'src/types/index.js'
import type { HookEventMetadata } from 'src/services/hooks/hooksConfigManager.js'
import { Box, Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  hookEventMetadata: Record<HookEvent, HookEventMetadata>
  hooksByEvent: Partial<Record<HookEvent, number>>
  totalHooksCount: number
  restrictedByPolicy: boolean
  onSelectEvent: (event: HookEvent) => void
  onCancel: () => void
}
export function SelectEventMode({
  hookEventMetadata,
  hooksByEvent,
  totalHooksCount,
  restrictedByPolicy,
  onSelectEvent,
  onCancel,
}: Props) {
  const hookCountLabel = plural(totalHooksCount, 'hook')
  const subtitle = tSync('hooks.configuredCount', { count: totalHooksCount, hook: hookCountLabel })
  const eventEntries = Object.entries(hookEventMetadata)
  const eventOptions = eventEntries.map((entry) => {
    const [name, metadata] = entry
    const count = hooksByEvent[name as HookEvent] || 0
    return {
      label:
        count > 0 ? (
          <Text>
            {name} <Text color="suggestion">({count})</Text>
          </Text>
        ) : (
          name
        ),
      value: name,
      description: metadata.summary,
    }
  })
  return (
    <Dialog title={tSync('hooks.title')} subtitle={subtitle} onCancel={onCancel}>
      {
        <Box flexDirection="column">
          <Select
            options={eventOptions}
            onChange={(value: string) => onSelectEvent(value as HookEvent)}
          />
        </Box>
      }
    </Dialog>
  )
}
