import { stripUnderlineAnsi } from 'src/components/shell/OutputLine.js'
import { extractTag } from 'src/utils/messages.js'
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import type { ToolResultBlock } from '../types/llm.js'
import { countCharInString } from '../utils/stringUtils.js'
import { MessageResponse } from './MessageResponse.js'

const MAX_RENDERED_LINES = 10
type Props = {
  result: ToolResultBlock['content']
  verbose: boolean
}
export function FallbackToolUseErrorMessage({ result, verbose }: Props) {
  const transcriptShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  let error: string
  if (typeof result !== 'string') {
    error = tSync('fallbackToolError.executionFailed')
  } else {
    const extractedError = extractTag(result, 'tool_use_error') ?? result
    const withoutSandboxViolations = removeSandboxViolationTags(extractedError)
    const withoutErrorTags = withoutSandboxViolations.replace(/<\/?error>/g, '')
    const trimmed = withoutErrorTags.trim()
    if (!verbose && trimmed.includes('InputValidationError: ')) {
      error = tSync('fallbackToolError.invalidParams')
    } else {
      if (trimmed.startsWith('Error: ') || trimmed.startsWith('Cancelled: ')) {
        error = trimmed
      } else {
        error = `Error: ${trimmed}`
      }
    }
  }
  const ErrorText = Text
  const ErrorContainer = Box
  const ErrorMessageResponse = MessageResponse
  const plusLines = countCharInString(error, '\n') + 1 - MAX_RENDERED_LINES
  const displayError = stripUnderlineAnsi(
    verbose ? error : error.split('\n').slice(0, MAX_RENDERED_LINES).join('\n'),
  )
  return (
    <ErrorMessageResponse>
      {
        <ErrorContainer flexDirection={'column'}>
          {<ErrorText color={'error'}>{displayError}</ErrorText>}
          {!verbose && plusLines > 0 && (
            <Box>
              <Text dimColor={true}>
                … +{plusLines}{' '}
                {plusLines === 1
                  ? tSync('fallbackToolError.lineSingular')
                  : tSync('fallbackToolError.linePlural')}{' '}
                (
              </Text>
              <Text dimColor={true} bold={true}>
                {transcriptShortcut}
              </Text>
              <Text> </Text>
              <Text dimColor={true}>
                {
                  tSync('fallbackToolError.moreLines', {
                    n: plusLines,
                    shortcut: transcriptShortcut,
                  }).split(' ')[0]
                }
              </Text>
            </Box>
          )}
        </ErrorContainer>
      }
    </ErrorMessageResponse>
  )
}
