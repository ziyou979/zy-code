import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js'
export function General() {
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      {
        <Box>
          <Text>{tSync('help.description')}</Text>
        </Box>
      }
      <Box flexDirection="column">
        <Box>
          <Text bold={true}>{tSync('help.shortcutsTitle')}</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth={true} />
      </Box>
    </Box>
  )
}
