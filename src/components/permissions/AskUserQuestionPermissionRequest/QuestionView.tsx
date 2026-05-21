import figures from 'figures'
import { useState } from 'react'
import { tSync } from '../../../i18n/index.js'
import { Box, Text } from '../../../ink.js'
import { useAppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { PastedContent } from '../../../utils/config.js'
import { getExternalEditor } from '../../../utils/editor.js'
import { toIDEDisplayName } from '../../../utils/ide.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { Select, SelectMulti } from '../../CustomSelect/index.js'
import { Divider } from '../../design-system/Divider.js'
import { FilePathLink } from '../../FilePathLink.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PreviewQuestionView } from './PreviewQuestionView.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'
import type { QuestionState } from './use-multiple-choice-state.js'

type Props = {
  question: Question
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  questionStates: Record<string, QuestionState>
  hideSubmitTab?: boolean
  planFilePath?: string
  pastedContents?: Record<number, PastedContent>
  minContentHeight?: number
  minContentWidth?: number
  outerMinHeight?: number
  onUpdateQuestionState: (
    questionText: string,
    updates: Partial<QuestionState>,
    isMultiSelect: boolean,
  ) => void
  onAnswer: (
    questionText: string,
    label: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void
  onTextInputFocus: (isInInput: boolean) => void
  onCancel: () => void
  onSubmit: () => void
  onTabPrev?: () => void
  onTabNext?: () => void
  onRespondToZy: () => void
  onFinishPlanInterview: () => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  onRemoveImage?: (id: number) => void
}
export function QuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  planFilePath,
  minContentHeight,
  minContentWidth,
  outerMinHeight,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onSubmit,
  onTabPrev,
  onTabNext,
  onRespondToZy,
  onFinishPlanInterview,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: Props) {
  const isInPlanMode = useAppState((s) => s.toolPermissionContext.mode) === 'plan'
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [footerIndex, setFooterIndex] = useState(0)
  const [isOtherFocused, setIsOtherFocused] = useState(false)
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : null
  const handleFocus = (value) => {
    const isOther = value === '__other__'
    setIsOtherFocused(isOther)
    onTextInputFocus(isOther)
  }
  const handleDownFromLastItem = () => {
    setIsFooterFocused(true)
  }
  const handleUpFromFooter = () => {
    setIsFooterFocused(false)
  }
  const handleKeyDown = (e) => {
    if (!isFooterFocused) {
      return
    }
    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault()
      if (footerIndex === 0) {
        handleUpFromFooter()
      } else {
        setFooterIndex(0)
      }
      return
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault()
      if (isInPlanMode && footerIndex === 0) {
        setFooterIndex(1)
      }
      return
    }
    if (e.key === 'return') {
      e.preventDefault()
      if (footerIndex === 0) {
        onRespondToZy()
      } else {
        onFinishPlanInterview()
      }
      return
    }
    if (e.key === 'escape') {
      e.preventDefault()
      onCancel()
    }
  }
  const textOptions = question.options.map((opt) => ({
    type: 'text' as const,
    value: opt.label,
    label: opt.label,
    description: opt.description,
  }))
  const questionText = question.question
  const questionState = questionStates[questionText]
  const handleOpenEditor = async (currentValue: string, setValue: (v: string) => void) => {
    const result = await editPromptInEditor(currentValue)
    if (result.content !== null && result.content !== currentValue) {
      setValue(result.content)
      onUpdateQuestionState(
        questionText,
        {
          textInputValue: result.content,
        },
        question.multiSelect ?? false,
      )
    }
  }
  const initialTextInputValue = questionState?.textInputValue ?? ''
  const otherOption = {
    type: 'input' as const,
    value: '__other__',
    label: tSync('permissionRules.otherOption'),
    placeholder: question.multiSelect
      ? tSync('permissionRules.typeSomethingMulti')
      : tSync('permissionRules.typeSomething'),
    initialValue: initialTextInputValue,
    onChange: (value_0) => {
      onUpdateQuestionState(
        questionText,
        {
          textInputValue: value_0,
        },
        question.multiSelect ?? false,
      )
    },
  }
  const options = [...textOptions, otherOption]
  const hasAnyPreview = !question.multiSelect && question.options.some((opt_0) => opt_0.preview)
  if (hasAnyPreview) {
    return (
      <PreviewQuestionView
        question={question}
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        questionStates={questionStates}
        hideSubmitTab={hideSubmitTab}
        minContentHeight={minContentHeight}
        minContentWidth={minContentWidth}
        outerMinHeight={outerMinHeight}
        onUpdateQuestionState={onUpdateQuestionState}
        onAnswer={onAnswer}
        onTextInputFocus={onTextInputFocus}
        onCancel={onCancel}
        onTabPrev={onTabPrev}
        onTabNext={onTabNext}
        onRespondToZy={onRespondToZy}
        onFinishPlanInterview={onFinishPlanInterview}
      />
    )
  }
  return (
    <Box
      flexDirection="column"
      marginTop={0}
      tabIndex={0}
      autoFocus={true}
      onKeyDown={handleKeyDown}
      minHeight={outerMinHeight}
    >
      {isInPlanMode && planFilePath && (
        <Box flexDirection="column" gap={0}>
          <Divider color="inactive" />
          <Text color="inactive">
            Planning: <FilePathLink filePath={planFilePath} />
          </Text>
        </Box>
      )}
      {
        <Box marginTop={-1}>
          <Divider color="inactive" />
        </Box>
      }
      {
        <Box flexDirection="column" paddingTop={0}>
          {
            <QuestionNavigationBar
              questions={questions}
              currentQuestionIndex={currentQuestionIndex}
              answers={answers}
              hideSubmitTab={hideSubmitTab}
            />
          }
          {<PermissionRequestTitle title={question.question} color="text" />}
          {
            <Box flexDirection="column" minHeight={minContentHeight}>
              {
                <Box marginTop={1}>
                  {question.multiSelect ? (
                    <SelectMulti
                      key={question.question}
                      options={options}
                      defaultValue={
                        questionStates[question.question]?.selectedValue as string[] | undefined
                      }
                      onChange={(values) => {
                        onUpdateQuestionState(
                          questionText,
                          {
                            selectedValue: values,
                          },
                          true,
                        )
                        const textInput = values.includes('__other__')
                          ? questionStates[questionText]?.textInputValue
                          : undefined
                        const finalValues = values
                          .filter((v) => v !== '__other__')
                          .concat(textInput ? [textInput] : [])
                        onAnswer(questionText, finalValues, undefined, false)
                      }}
                      onFocus={handleFocus}
                      onCancel={onCancel}
                      submitButtonText={
                        currentQuestionIndex === questions.length - 1
                          ? tSync('permissionRules.submit')
                          : tSync('permissionRules.next')
                      }
                      onSubmit={onSubmit}
                      onDownFromLastItem={handleDownFromLastItem}
                      isDisabled={isFooterFocused}
                      onOpenEditor={handleOpenEditor}
                      onImagePaste={onImagePaste}
                      pastedContents={pastedContents}
                      onRemoveImage={onRemoveImage}
                    />
                  ) : (
                    <Select
                      key={question.question}
                      options={options}
                      defaultValue={
                        questionStates[question.question]?.selectedValue as string | undefined
                      }
                      onChange={(value_1) => {
                        onUpdateQuestionState(
                          questionText,
                          {
                            selectedValue: value_1,
                          },
                          false,
                        )
                        const textInput_0 =
                          value_1 === '__other__'
                            ? questionStates[questionText]?.textInputValue
                            : undefined
                        onAnswer(questionText, value_1, textInput_0)
                      }}
                      onFocus={handleFocus}
                      onCancel={onCancel}
                      onDownFromLastItem={handleDownFromLastItem}
                      isDisabled={isFooterFocused}
                      layout="compact-vertical"
                      onOpenEditor={handleOpenEditor}
                      onImagePaste={onImagePaste}
                      pastedContents={pastedContents}
                      onRemoveImage={onRemoveImage}
                    />
                  )}
                </Box>
              }
              {
                <Box flexDirection="column">
                  {<Divider color="inactive" />}
                  {
                    <Box flexDirection="row" gap={1}>
                      {isFooterFocused && footerIndex === 0 ? (
                        <Text color="suggestion">{figures.pointer}</Text>
                      ) : (
                        <Text> </Text>
                      )}
                      {
                        <Text
                          color={isFooterFocused && footerIndex === 0 ? 'suggestion' : undefined}
                        >
                          {options.length + 1}. {tSync('permissionRules.chatAboutThis')}
                        </Text>
                      }
                    </Box>
                  }
                  {isInPlanMode && (
                    <Box flexDirection="row" gap={1}>
                      {isFooterFocused && footerIndex === 1 ? (
                        <Text color="suggestion">{figures.pointer}</Text>
                      ) : (
                        <Text> </Text>
                      )}
                      <Text color={isFooterFocused && footerIndex === 1 ? 'suggestion' : undefined}>
                        {options.length + 2}. {tSync('permissionRules.skipInterviewAndPlan')}
                      </Text>
                    </Box>
                  )}
                </Box>
              }
              {
                <Box marginTop={1}>
                  <Text color="inactive" dimColor={true}>
                    {tSync('permissionRules.enterToSelect')} ·{' '}
                    {questions.length === 1 ? (
                      <>
                        {figures.arrowUp}/{figures.arrowDown}{' '}
                        {tSync('permissionRules.arrowToNavigate')}
                      </>
                    ) : (
                      tSync('permissionRules.tabArrowToNavigate')
                    )}
                    {isOtherFocused && editorName && (
                      <> · {tSync('permissionRules.ctrlGToEditIn', { editorName })}</>
                    )}{' '}
                    · {tSync('permissionRules.escToCancelHint')}
                  </Text>
                </Box>
              }
            </Box>
          }
        </Box>
      }
    </Box>
  )
}
