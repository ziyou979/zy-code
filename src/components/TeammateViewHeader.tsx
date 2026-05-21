import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import { toInkColor } from '../utils/ink.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'

/**
 * Header shown when viewing a teammate's transcript.
 * Displays teammate name (colored), task description, and exit hint.
 */
export function TeammateViewHeader() {
  const viewedTeammate = useAppState((s) => getViewedTeammateTask(s))
  if (!viewedTeammate) {
    return null
  }
  const nameColor = toInkColor(viewedTeammate.identity.color)
  return (
    <OffscreenFreeze>
      <Box flexDirection="column" marginBottom={1}>
        {
          <Box>
            {<Text>{tSync('teammateView.viewing')} </Text>}
            {
              <Text color={nameColor} bold={true}>
                @{viewedTeammate.identity.agentName}
              </Text>
            }
            {
              <Text dimColor={true}>
                {' \xB7 '}
                <KeyboardShortcutHint shortcut="esc" action="return" />
              </Text>
            }
          </Box>
        }
        {<Text dimColor={true}>{viewedTeammate.prompt}</Text>}
      </Box>
    </OffscreenFreeze>
  )
}
