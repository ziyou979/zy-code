import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'

type Props = {
  instructions?: string
}
export function AgentNavigationFooter({ instructions = tSync('agents.navInstructions') }: Props) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  return (
    <Box marginLeft={2}>
      <Text dimColor={true}>
        {exitState.pending ? `Press ${exitState.keyName} again to exit` : instructions}
      </Text>
    </Box>
  )
}
