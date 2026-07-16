import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
export function CompactBoundaryMessage() {
  const historyShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  return (
    <Box marginY={1}>
      <Text dimColor={true}>
        ✻{' '}
        {tSync('compact.compacted', {
          shortcut: historyShortcut,
        })}
      </Text>
    </Box>
  )
}
