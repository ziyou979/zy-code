import { useCallback, useRef } from 'react'
import { useTerminalFocus } from '../ink/hooks/useTerminalFocus.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { abortSpeculation } from '../services/prompt-suggestion/speculation.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { isInternalBuild } from '../services/infra/envUtils.js'

type Props = {
  inputValue: string
  isAssistantResponding: boolean
}

export function usePromptSuggestion({ inputValue, isAssistantResponding }: Props): {
  suggestion: string | null
  markAccepted: () => void
  markShown: () => void
  logOutcomeAtSubmission: (finalInput: string, opts?: { skipReset: boolean }) => void
} {
  const promptSuggestion = useAppState((s) => s.promptSuggestion)
  const setAppState = useSetAppState()
  const isTerminalFocused = useTerminalFocus()
  const {
    text: suggestionText,
    promptId,
    shownAt,
    acceptedAt,
    generationRequestId,
  } = promptSuggestion

  const suggestion = isAssistantResponding || inputValue.length > 0 ? null : suggestionText

  const isValidSuggestion = suggestionText && shownAt > 0

  // 跟踪 engagement 深度，用于 telemetry
  const firstKeystrokeAt = useRef<number>(0)
  const wasFocusedWhenShown = useRef<boolean>(true)
  const prevShownAt = useRef<number>(0)

  // 新 suggestion 出现（shownAt 变化）时捕获焦点状态
  if (shownAt > 0 && shownAt !== prevShownAt.current) {
    prevShownAt.current = shownAt
    wasFocusedWhenShown.current = isTerminalFocused
    firstKeystrokeAt.current = 0
  } else if (shownAt === 0) {
    prevShownAt.current = 0
  }

  // 记录 suggestion 可见期间的首次按键
  if (inputValue.length > 0 && firstKeystrokeAt.current === 0 && isValidSuggestion) {
    firstKeystrokeAt.current = Date.now()
  }

  const resetSuggestion = useCallback(() => {
    abortSpeculation(setAppState)

    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }))
  }, [setAppState])

  const markAccepted = useCallback(() => {
    if (!isValidSuggestion) {
      return
    }
    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        ...prev.promptSuggestion,
        acceptedAt: Date.now(),
      },
    }))
  }, [isValidSuggestion, setAppState])

  const markShown = useCallback(() => {
    // 在 setAppState callback 内检查 shownAt，避免依赖它；
    // 否则调用此 callback 时会造成无限循环
    setAppState((prev) => {
      // 仅在尚未标记且 suggestion 存在时标记为已显示
      if (prev.promptSuggestion.shownAt !== 0 || !prev.promptSuggestion.text) {
        return prev
      }
      return {
        ...prev,
        promptSuggestion: {
          ...prev.promptSuggestion,
          shownAt: Date.now(),
        },
      }
    })
  }, [setAppState])

  const logOutcomeAtSubmission = useCallback(
    (finalInput: string, opts?: { skipReset: boolean }) => {
      if (!isValidSuggestion) {
        return
      }

      // 判断是否接受：按下 Tab（已设置 acceptedAt），或最终输入与 suggestion 匹配
      //（空输入按 Enter 的情况）
      const tabWasPressed = acceptedAt > shownAt
      const wasAccepted = tabWasPressed || finalInput === suggestionText
      const timeMs = wasAccepted ? acceptedAt || Date.now() : Date.now()

      logEvent('zy_prompt_suggestion', {
        source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        outcome: (wasAccepted
          ? 'accepted'
          : 'ignored') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        prompt_id: promptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(generationRequestId && {
          generationRequestId:
            generationRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(wasAccepted && {
          acceptMethod: (tabWasPressed
            ? 'tab'
            : 'enter') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(wasAccepted && {
          timeToAcceptMs: timeMs - shownAt,
        }),
        ...(!wasAccepted && {
          timeToIgnoreMs: timeMs - shownAt,
        }),
        ...(firstKeystrokeAt.current > 0 && {
          timeToFirstKeystrokeMs: firstKeystrokeAt.current - shownAt,
        }),
        wasFocusedWhenShown: wasFocusedWhenShown.current,
        similarity: Math.round((finalInput.length / (suggestionText?.length || 1)) * 100) / 100,
        ...(isInternalBuild() && {
          suggestion: suggestionText as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          userInput: finalInput as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      })
      if (!opts?.skipReset) {
        resetSuggestion()
      }
    },
    [
      isValidSuggestion,
      acceptedAt,
      shownAt,
      suggestionText,
      promptId,
      generationRequestId,
      resetSuggestion,
    ],
  )

  return {
    suggestion,
    markAccepted,
    markShown,
    logOutcomeAtSubmission,
  }
}
