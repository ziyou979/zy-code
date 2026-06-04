import { type ReactNode, useState } from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { KeybindingAction } from '../../keybindings/types.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useSetAppState } from '../../state/AppState.js'
import { Select } from '../CustomSelect/select.js'
export type FeedbackType = 'accept' | 'reject'
export type PermissionPromptOption<T extends string> = {
  value: T
  label: ReactNode
  feedbackConfig?: {
    type: FeedbackType
    placeholder?: string
  }
  keybinding?: KeybindingAction
}
export type ToolAnalyticsContext = {
  toolName: string
  isMcp: boolean
}
export type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[]
  onSelect: (value: T, feedback?: string) => void
  onCancel?: () => void
  question?: string | ReactNode
  toolAnalyticsContext?: ToolAnalyticsContext
}
// getter：惰性求值，避免模块顶层冻结翻译；语言切换后即时反应。
const getDefaultPlaceholders = (): Record<FeedbackType, string> => ({
  accept: tSync('permission.feedbackAccept'),
  reject: tSync('permission.feedbackReject'),
})

/**
 * Shared component for permission prompts with optional feedback input.
 *
 * Handles:
 * - "Do you want to proceed?" question with optional Tab hint
 * - Feature flag check for feedback capability
 * - Input mode toggling (Tab to expand feedback input)
 * - Analytics events for feedback interactions
 * - Transforming options to Select-compatible format
 */
export function PermissionPrompt<T extends string>({
  options,
  onSelect,
  onCancel,
  question = tSync('permission.doYouWantToProceed'),
  toolAnalyticsContext,
}: PermissionPromptProps<T>) {
  const setAppState = useSetAppState()
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [acceptInputMode, setAcceptInputMode] = useState(false)
  const [rejectInputMode, setRejectInputMode] = useState(false)
  const [focusedValue, setFocusedValue] = useState(null)
  const [acceptFeedbackModeEntered, setAcceptFeedbackModeEntered] = useState(false)
  const [rejectFeedbackModeEntered, setRejectFeedbackModeEntered] = useState(false)
  const focusedOption = options.find((opt) => opt.value === focusedValue)
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type
  const showTabHint =
    (focusedFeedbackType === 'accept' && !acceptInputMode) ||
    (focusedFeedbackType === 'reject' && !rejectInputMode)
  const selectOptions = options.map((opt_0) => {
    const { value, label, feedbackConfig } = opt_0
    if (!feedbackConfig) {
      return {
        label,
        value,
      }
    }
    const { type, placeholder } = feedbackConfig
    const isInputMode = type === 'accept' ? acceptInputMode : rejectInputMode
    const onChange = type === 'accept' ? setAcceptFeedback : setRejectFeedback
    const defaultPlaceholder = getDefaultPlaceholders()[type]
    if (isInputMode) {
      return {
        type: 'input' as const,
        label,
        value,
        placeholder: placeholder ?? defaultPlaceholder,
        onChange,
        allowEmptySubmitToCancel: true,
      }
    }
    return {
      label,
      value,
    }
  })
  const handleInputModeToggle = (value_0: string) => {
    const option = options.find((opt_1) => opt_1.value === value_0)
    if (!option?.feedbackConfig) {
      return
    }
    const { type: type_0 } = option.feedbackConfig
    const analyticsProps = {
      toolName:
        toolAnalyticsContext?.toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      isMcp: toolAnalyticsContext?.isMcp ?? false,
    }
    if (type_0 === 'accept') {
      if (acceptInputMode) {
        setAcceptInputMode(false)
        logEvent('zy_accept_feedback_mode_collapsed', analyticsProps)
      } else {
        setAcceptInputMode(true)
        setAcceptFeedbackModeEntered(true)
        logEvent('zy_accept_feedback_mode_entered', analyticsProps)
      }
    } else {
      if (type_0 === 'reject') {
        if (rejectInputMode) {
          setRejectInputMode(false)
          logEvent('zy_reject_feedback_mode_collapsed', analyticsProps)
        } else {
          setRejectInputMode(true)
          setRejectFeedbackModeEntered(true)
          logEvent('zy_reject_feedback_mode_entered', analyticsProps)
        }
      }
    }
  }
  const handleSelect = (value_1: string) => {
    const option_0 = options.find((opt_2) => opt_2.value === value_1)
    if (!option_0) {
      return
    }
    let feedback
    if (option_0.feedbackConfig) {
      const rawFeedback =
        option_0.feedbackConfig.type === 'accept' ? acceptFeedback : rejectFeedback
      const trimmedFeedback = rawFeedback.trim()
      if (trimmedFeedback) {
        feedback = trimmedFeedback
      }
      const analyticsProps_0 = {
        toolName:
          toolAnalyticsContext?.toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: toolAnalyticsContext?.isMcp ?? false,
        has_instructions: !!trimmedFeedback,
        instructions_length: trimmedFeedback?.length ?? 0,
        entered_feedback_mode:
          option_0.feedbackConfig.type === 'accept'
            ? acceptFeedbackModeEntered
            : rejectFeedbackModeEntered,
      }
      if (option_0.feedbackConfig.type === 'accept') {
        logEvent('zy_accept_submitted', analyticsProps_0)
      } else {
        if (option_0.feedbackConfig.type === 'reject') {
          logEvent('zy_reject_submitted', analyticsProps_0)
        }
      }
    }
    onSelect(value_1 as T, feedback)
  }
  const handlers: Record<string, () => void> = {}
  for (const opt_3 of options) {
    if (opt_3.keybinding) {
      handlers[opt_3.keybinding] = () => handleSelect(opt_3.value)
    }
  }
  const keybindingHandlers = handlers
  useKeybindings(keybindingHandlers, {
    context: 'Confirmation',
  })
  const handleCancel = () => {
    logEvent('zy_permission_request_escape', {})
    setAppState((prev) => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        escapeCount: prev.attribution.escapeCount + 1,
      },
    }))
    onCancel?.()
  }
  const tabHintText =
    showTabHint &&
    tSync('permission.tabToAmend', {
      amend: tSync('permission.amend'),
    })
  return (
    <Box flexDirection="column">
      {typeof question === 'string' ? <Text>{question}</Text> : question}
      {
        <Select
          options={selectOptions}
          inlineDescriptions={true}
          onChange={handleSelect}
          onCancel={handleCancel}
          onFocus={(value_2: string) => {
            const newOption = options.find((opt_4) => opt_4.value === value_2)
            if (
              newOption?.feedbackConfig?.type !== 'accept' &&
              acceptInputMode &&
              !acceptFeedback.trim()
            ) {
              setAcceptInputMode(false)
            }
            if (
              newOption?.feedbackConfig?.type !== 'reject' &&
              rejectInputMode &&
              !rejectFeedback.trim()
            ) {
              setRejectInputMode(false)
            }
            // biome-ignore lint/suspicious/noExplicitAny: 权限系统动态类型处理
            setFocusedValue(value_2 as any)
          }}
          onInputModeToggle={handleInputModeToggle}
        />
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('permission.escToCancel', {
              cancel: tSync('permission.cancel'),
            })}
            {tabHintText}
          </Text>
        </Box>
      }
    </Box>
  )
}
