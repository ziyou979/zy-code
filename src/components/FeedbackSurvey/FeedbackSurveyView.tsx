import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js'
import type { FeedbackSurveyResponse } from './utils.js'

type Props = {
  onSelect: (option: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
  message?: string
}
const RESPONSE_INPUTS = ['0', '1', '2', '3'] as const
type ResponseInput = (typeof RESPONSE_INPUTS)[number]
const inputToResponse: Record<ResponseInput, FeedbackSurveyResponse> = {
  '0': 'dismissed',
  '1': 'bad',
  '2': 'fine',
  '3': 'good',
} as const
export const isValidResponseInput = (input: string): input is ResponseInput =>
  (RESPONSE_INPUTS as readonly string[]).includes(input)
export function FeedbackSurveyView({
  onSelect,
  inputValue,
  setInputValue,
  // 默认参数在每次调用（渲染）时求值 → 惰性且随语言切换反应，避免模块顶层冻结。
  message = tSync('feedbackSurvey.defaultMessage'),
}: Props) {
  useDebouncedDigitInput({
    inputValue,
    setInputValue,
    isValidDigit: isValidResponseInput,
    onDigit: (digit) => onSelect(inputToResponse[digit]),
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      {
        <Box>
          {<Text color="ansi:cyan">● </Text>}
          <Text bold={true}>{message}</Text>
        </Box>
      }
      {
        <Box marginLeft={2}>
          {
            <Box width={10}>
              <Text>
                <Text color="ansi:cyan">1</Text>: {tSync('feedbackSurvey.bad')}
              </Text>
            </Box>
          }
          {
            <Box width={10}>
              <Text>
                <Text color="ansi:cyan">2</Text>: {tSync('feedbackSurvey.fine')}
              </Text>
            </Box>
          }
          {
            <Box width={10}>
              <Text>
                <Text color="ansi:cyan">3</Text>: {tSync('feedbackSurvey.good')}
              </Text>
            </Box>
          }
          <Box>
            <Text>
              <Text color="ansi:cyan">0</Text>: {tSync('feedbackSurvey.dismiss')}
            </Text>
          </Box>
        </Box>
      }
    </Box>
  )
}
