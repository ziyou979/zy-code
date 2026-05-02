import * as React from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../../ink.js'
type Props = {
  instructions?: string
}
export function AgentNavigationFooter({
  instructions = 'Press \u2191\u2193 to navigate \xB7 Enter to select \xB7 Esc to go back',
}: Props) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  return (
    <Box marginLeft={2}>
      <Text dimColor={true}>
        {exitState.pending ? `Press ${exitState.keyName} again to exit` : instructions}
      </Text>
    </Box>
  )
}
