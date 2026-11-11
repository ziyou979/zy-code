import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { FeedbackSurveyView, isValidResponseInput } from './FeedbackSurveyView.js'
import type { SurveyState } from './useSurveyState.js'
import type { FeedbackSurveyResponse } from './utils.js'

type Props = {
  state: SurveyState
  lastResponse: FeedbackSurveyResponse | null
  handleSelect: (selected: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
  message?: string
}
export function FeedbackSurvey({ state, handleSelect, inputValue, setInputValue, message }: Props) {
  if (state === 'closed') {
    return null
  }
  if (state === 'thanks') {
    // 原上游在此引导 /feedback 或会话转录上传（都提交到 Anthropic 后端），ZY Code 已移除，只致谢。
    return (
      <Box marginTop={1}>
        <Text color="success">{tSync('feedbackSurvey.thanksFeedback')}</Text>
      </Box>
    )
  }
  if (inputValue && !isValidResponseInput(inputValue)) {
    return null
  }
  return (
    <FeedbackSurveyView
      onSelect={handleSelect}
      inputValue={inputValue}
      setInputValue={setInputValue}
      message={message}
    />
  )
}
