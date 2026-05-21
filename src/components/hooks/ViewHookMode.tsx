import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../../ink.js'
import {
  hookSourceDescriptionDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  selectedHook: IndividualHookConfig
  eventSupportsMatcher: boolean
  onCancel: () => void
}
export function ViewHookMode({ selectedHook, eventSupportsMatcher, onCancel }: Props) {
  const sourceDescription = hookSourceDescriptionDisplayString(selectedHook.source)
  const contentFieldLabel = getContentFieldLabel(selectedHook.config)
  const contentFieldValue = getContentFieldValue(selectedHook.config)
  return (
    <Dialog
      title={tSync('hooks.viewDetails')}
      onCancel={onCancel}
      inputGuide={() => <Text>{tSync('hooks.escToGoBack')}</Text>}
    >
      {
        <Box flexDirection="column" gap={1}>
          {
            <Box flexDirection="column">
              {
                <Text>
                  {tSync('hooks.eventLabel')} <Text bold={true}>{selectedHook.event}</Text>
                </Text>
              }
              {eventSupportsMatcher && (
                <Text>
                  {tSync('hooks.matcherLabel')}{' '}
                  <Text bold={true}>{selectedHook.matcher || tSync('hooks.allMatcher')}</Text>
                </Text>
              )}
              {
                <Text>
                  {tSync('hooks.typeLabel')} <Text bold={true}>{selectedHook.config.type}</Text>
                </Text>
              }
              {
                <Text>
                  {tSync('hooks.sourceLabel')} <Text dimColor={true}>{sourceDescription}</Text>
                </Text>
              }
              {selectedHook.pluginName && (
                <Text>
                  {tSync('hooks.pluginLabel')}{' '}
                  <Text dimColor={true}>{selectedHook.pluginName}</Text>
                </Text>
              )}
            </Box>
          }
          {
            <Box flexDirection="column">
              {<Text dimColor={true}>{contentFieldLabel}:</Text>}
              {
                <Box borderStyle="round" borderDimColor={true} paddingLeft={1} paddingRight={1}>
                  <Text>{contentFieldValue}</Text>
                </Box>
              }
            </Box>
          }
          {'statusMessage' in selectedHook.config && selectedHook.config.statusMessage && (
            <Text>
              {tSync('hooks.statusMessageLabel')}{' '}
              <Text dimColor={true}>{selectedHook.config.statusMessage}</Text>
            </Text>
          )}
          {<Text dimColor={true}>{tSync('hooks.editInstructions')}</Text>}
        </Box>
      }
    </Dialog>
  )
}

/**
 * Get a human-readable label for the primary content field of a hook
 * based on its type.
 */

function getContentFieldLabel(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return tSync('hooks.commandLabel')
    case 'prompt':
      return tSync('hooks.promptLabel')
    case 'agent':
      return tSync('hooks.promptLabel')
    case 'http':
      return tSync('hooks.urlLabel')
  }
}

/**
 * Get the actual content value for a hook's primary field, bypassing
 * statusMessage so the detail view always shows the real command/prompt/URL.
 */
function getContentFieldValue(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return config.command
    case 'prompt':
      return config.prompt
    case 'agent':
      return config.prompt
    case 'http':
      return config.url
  }
}
