import { tSync } from 'src/i18n/index.js'
import { ARROW_RIGHT, BULLET, WARNING } from '../../../constants/figures.js'
import { Box, Text } from '../../../ink.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import { Select } from '../../CustomSelect/index.js'
import { Divider } from '../../design-system/Divider.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'

type Props = {
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  allQuestionsAnswered: boolean
  permissionResult: PermissionDecision
  minContentHeight?: number
  outerMinHeight?: number
  onFinalResponse: (value: 'submit' | 'cancel') => void
}
export function SubmitQuestionsView({
  questions,
  currentQuestionIndex,
  answers,
  allQuestionsAnswered,
  permissionResult,
  minContentHeight,
  outerMinHeight,
  onFinalResponse,
}: Props) {
  return (
    <Box flexDirection="column" marginTop={1} minHeight={outerMinHeight}>
      {<Divider color="inactive" />}
      <Box flexDirection="column" borderTop={true} borderColor="inactive" paddingTop={0}>
        {
          <QuestionNavigationBar
            questions={questions}
            currentQuestionIndex={currentQuestionIndex}
            answers={answers}
          />
        }
        {<PermissionRequestTitle title={tSync('permissionRules.reviewYourAnswers')} color="text" />}
        {
          <Box flexDirection="column" marginTop={1} minHeight={minContentHeight}>
            {!allQuestionsAnswered && (
              <Box marginBottom={1}>
                <Text color="warning">
                  {WARNING} {tSync('permissionRules.notAnsweredAllQuestions')}
                </Text>
              </Box>
            )}
            {Object.keys(answers).length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                {questions
                  .filter((q) => q?.question && answers[q.question])
                  .map((q_0) => {
                    const answer = answers[q_0?.question]
                    return (
                      <Box key={q_0?.question || 'answer'} flexDirection="column" marginLeft={1}>
                        <Text>
                          {BULLET} {q_0?.question || tSync('permissionRules.questionLabel')}
                        </Text>
                        <Box marginLeft={2}>
                          <Text color="success">
                            {ARROW_RIGHT} {answer}
                          </Text>
                        </Box>
                      </Box>
                    )
                  })}
              </Box>
            )}
            {<PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />}
            {<Text color="inactive">{tSync('permissionRules.readyToSubmitAnswers')}</Text>}
            {
              <Box marginTop={1}>
                <Select
                  options={[
                    {
                      type: 'text' as const,
                      label: tSync('permissionRules.submitAnswers'),
                      value: 'submit',
                    },
                    {
                      type: 'text' as const,
                      label: tSync('permissionRules.cancel'),
                      value: 'cancel',
                    },
                  ]}
                  onChange={(value: string) => onFinalResponse(value as 'submit' | 'cancel')}
                  onCancel={() => onFinalResponse('cancel')}
                />
              </Box>
            }
          </Box>
        }
      </Box>
    </Box>
  )
}
