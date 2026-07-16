import { useEffect, useRef } from 'react'
import { BLACK_CIRCLE, BULLET_OPERATOR } from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import type { SkillUpdate } from '../services/hooks/skillImprovement.js'
import { normalizeFullWidthDigits } from '../utils/stringUtils.js'
import { isValidResponseInput } from './FeedbackSurvey/FeedbackSurveyView.js'
import type { FeedbackSurveyResponse } from './FeedbackSurvey/utils.js'

type Props = {
  isOpen: boolean
  skillName: string
  updates: SkillUpdate[]
  handleSelect: (selected: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
}
export function SkillImprovementSurvey({
  isOpen,
  skillName,
  updates,
  handleSelect,
  inputValue,
  setInputValue,
}: Props) {
  if (!isOpen) {
    return null
  }
  if (inputValue && !isValidResponseInput(inputValue)) {
    return null
  }
  return (
    <SkillImprovementSurveyView
      skillName={skillName}
      updates={updates}
      onSelect={handleSelect}
      inputValue={inputValue}
      setInputValue={setInputValue}
    />
  )
}
type ViewProps = {
  skillName: string
  updates: SkillUpdate[]
  onSelect: (option: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
}

// 仅 1（应用）和 0（关闭）对此调查有效
const VALID_INPUTS = ['0', '1'] as const
function isValidInput(input: string): boolean {
  return (VALID_INPUTS as readonly string[]).includes(input)
}
function SkillImprovementSurveyView({
  skillName,
  updates,
  onSelect,
  inputValue,
  setInputValue,
}: ViewProps) {
  const initialInputValue = useRef(inputValue)
  useEffect(() => {
    if (inputValue !== initialInputValue.current) {
      const lastChar = normalizeFullWidthDigits(inputValue.slice(-1))
      if (isValidInput(lastChar)) {
        setInputValue(inputValue.slice(0, -1))
        onSelect(lastChar === '1' ? 'good' : 'dismissed')
      }
    }
  }, [inputValue, onSelect, setInputValue])
  const updateItems = updates.map((u, i) => (
    <Text key={i} dimColor={true}>
      {BULLET_OPERATOR} {u.change}
    </Text>
  ))
  return (
    <Box flexDirection="column" marginTop={1}>
      {
        <Box>
          {<Text color="ansi:cyan">{BLACK_CIRCLE} </Text>}
          <Text bold={true}>{tSync('skills.improvement.suggested', { skillName })}</Text>
        </Box>
      }
      {
        <Box flexDirection="column" marginLeft={2}>
          {updateItems}
        </Box>
      }
      {
        <Box marginLeft={2} marginTop={1}>
          {
            <Box width={12}>
              <Text>
                <Text color="ansi:cyan">1</Text>: {tSync('skills.improvement.apply')}
              </Text>
            </Box>
          }
          <Box width={14}>
            <Text>
              <Text color="ansi:cyan">0</Text>: {tSync('skills.improvement.dismiss')}
            </Text>
          </Box>
        </Box>
      }
    </Box>
  )
}
