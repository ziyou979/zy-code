import { CHECKBOX_OFF, CHECKBOX_ON, TICK } from '../../../constants/figures.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { truncateToWidth } from '../../../utils/format.js'

type Props = {
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  hideSubmitTab?: boolean
}
export function QuestionNavigationBar({
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab = false,
}: Props) {
  const { columns } = useTerminalSize()
  let tabDisplayTexts
  const submitText = hideSubmitTab ? '' : ` ${TICK} Submit `
  const fixedWidth = stringWidth('\u2190 ') + stringWidth(' \u2192') + stringWidth(submitText)
  const availableForTabs = columns - fixedWidth
  if (availableForTabs <= 0) {
    tabDisplayTexts = questions.map((q, index) => {
      const header = q?.header || `Q${index + 1}`
      return index === currentQuestionIndex ? header.slice(0, 3) : ''
    })
  } else {
    const tabHeaders = questions.map((q_0, index_0) => q_0?.header || `Q${index_0 + 1}`)
    const idealWidths = tabHeaders.map((header_0) => 4 + stringWidth(header_0))
    const totalIdealWidth = idealWidths.reduce((sum, w) => sum + w, 0)
    if (totalIdealWidth <= availableForTabs) {
      tabDisplayTexts = tabHeaders
    } else {
      const currentHeader = tabHeaders[currentQuestionIndex] || ''
      const currentIdealWidth = 4 + stringWidth(currentHeader)
      const currentTabWidth = Math.min(currentIdealWidth, availableForTabs / 2)
      const remainingWidth = availableForTabs - currentTabWidth
      const otherTabCount = questions.length - 1
      const widthPerOtherTab = Math.max(6, Math.floor(remainingWidth / Math.max(otherTabCount, 1)))
      tabDisplayTexts = tabHeaders.map((header_1, index_1) => {
        if (index_1 === currentQuestionIndex) {
          const maxTextWidth = currentTabWidth - 2 - 2
          return truncateToWidth(header_1, maxTextWidth)
        } else {
          const maxTextWidth_0 = widthPerOtherTab - 2 - 2
          return truncateToWidth(header_1, maxTextWidth_0)
        }
      })
    }
  }
  const hideArrows = questions.length === 1 && hideSubmitTab
  const tabElements = questions.map((q_1, index_2) => {
    const isSelected = index_2 === currentQuestionIndex
    const isAnswered = q_1?.question && !!answers[q_1.question]
    const checkbox = isAnswered ? CHECKBOX_ON : CHECKBOX_OFF
    const displayText = tabDisplayTexts[index_2] || q_1?.header || `Q${index_2 + 1}`
    return (
      <Box key={q_1?.question || `question-${index_2}`}>
        {isSelected ? (
          <Text backgroundColor="permission" color="inverseText">
            {' '}
            {checkbox} {displayText}{' '}
          </Text>
        ) : (
          <Text>
            {' '}
            {checkbox} {displayText}{' '}
          </Text>
        )}
      </Box>
    )
  })
  return (
    <Box flexDirection="row" marginBottom={1}>
      {!hideArrows && <Text color={currentQuestionIndex === 0 ? 'inactive' : undefined}>← </Text>}
      {tabElements}
      {!hideSubmitTab && (
        <Box key="submit">
          {currentQuestionIndex === questions.length ? (
            <Text backgroundColor="permission" color="inverseText">
              {' '}
              {TICK} Submit{' '}
            </Text>
          ) : (
            <Text> {TICK} Submit </Text>
          )}
        </Box>
      )}
      {!hideArrows && (
        <Text color={currentQuestionIndex === questions.length ? 'inactive' : undefined}> →</Text>
      )}
    </Box>
  )
}
