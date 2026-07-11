import { POINTER_SMALL } from '../../constants/figures.js'
import { Box, Text } from 'src/ink.js'

type Props = {
  hasStash: boolean
}
export function PromptInputStashNotice({ hasStash }: Props) {
  if (!hasStash) {
    return null
  }
  return (
    <Box paddingLeft={2}>
      <Text dimColor={true}>{POINTER_SMALL} Stashed (auto-restores after submit)</Text>
    </Box>
  )
}
