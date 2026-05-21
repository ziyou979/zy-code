import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { ThinkingBlock } from '../../types/llm.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

type Props = {
  // Accept either full ThinkingBlock/ThinkingBlock or a minimal shape with just type and thinking
  param:
    | ThinkingBlock
    | ThinkingBlock
    | {
        type: 'thinking'
        thinking: string
      }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
  /** When true, hide this thinking block entirely (used for past thinking in transcript mode) */
  hideInTranscript?: boolean
}
export function AssistantThinkingMessage({
  param: thinkingBlock,
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
}: Props) {
  const { thinking } = thinkingBlock
  if (!thinking) {
    return null
  }
  if (hideInTranscript) {
    return null
  }
  const shouldShowFullThinking = isTranscriptMode || verbose
  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        {
          <Text dimColor={true} italic={true}>
            {`\u2234 ${tSync('assistantThinking.label')}`} <CtrlOToExpand />
          </Text>
        }
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      {<Text dimColor={true} italic={true}>{`\u2234 ${tSync('assistantThinking.thinking')}`}</Text>}
      {
        <Box paddingLeft={2}>
          <Markdown dimColor={true}>{thinking}</Markdown>
        </Box>
      }
    </Box>
  )
}
