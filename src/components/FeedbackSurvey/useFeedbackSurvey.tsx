import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDynamicConfig } from 'src/hooks/useDynamicConfig.js'
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getMainLoopModel } from '../../services/model/model.js'
import { logOTelEvent } from '../../services/telemetry/events.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { getLastAssistantMessage } from '../../services/messages/./predicates.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import { type SurveyState, useSurveyState } from './useSurveyState.js'
import type { FeedbackSurveyResponse, FeedbackSurveyType } from './utils.js'

type FeedbackSurveyConfig = {
  minTimeBeforeFeedbackMs: number
  minTimeBetweenFeedbackMs: number
  minTimeBetweenGlobalFeedbackMs: number
  minUserTurnsBeforeFeedback: number
  minUserTurnsBetweenFeedback: number
  hideThanksAfterMs: number
  onForModels: string[]
  probability: number
}
const DEFAULT_FEEDBACK_SURVEY_CONFIG: FeedbackSurveyConfig = {
  minTimeBeforeFeedbackMs: 600000,
  minTimeBetweenFeedbackMs: 3600000,
  minTimeBetweenGlobalFeedbackMs: 100000000,
  minUserTurnsBeforeFeedback: 5,
  minUserTurnsBetweenFeedback: 10,
  hideThanksAfterMs: 3000,
  onForModels: ['*'],
  probability: 0.005,
}
export function useFeedbackSurvey(
  messages: Message[],
  isLoading: boolean,
  submitCount: number,
  surveyType: FeedbackSurveyType = 'feedback',
  hasActivePrompt: boolean = false,
): {
  state: SurveyState
  lastResponse: FeedbackSurveyResponse | null
  handleSelect: (selected: FeedbackSurveyResponse) => void
} {
  const lastAssistantMessageIdRef = useRef('unknown')
  lastAssistantMessageIdRef.current = getLastAssistantMessage(messages)?.message?.id || 'unknown'
  const [feedbackSurvey, setFeedbackSurvey] = useState<{
    timeLastShown: number | null
    submitCountAtLastAppearance: number | null
  }>(() => ({
    timeLastShown: null,
    submitCountAtLastAppearance: null,
  }))
  const config = useDynamicConfig<FeedbackSurveyConfig>(
    'zy_feedback_survey_config',
    DEFAULT_FEEDBACK_SURVEY_CONFIG,
  )
  const settingsRate = getInitialSettings().feedbackSurveyRate
  const sessionStartTime = useRef(Date.now())
  const submitCountAtSessionStart = useRef(submitCount)
  const submitCountRef = useRef(submitCount)
  submitCountRef.current = submitCount
  // Probability gate: roll once when eligibility conditions are met, not on every
  // useMemo re-evaluation. Without this, each dependency change (submitCount,
  // isLoading toggle, etc.) re-rolls Math.random(), making the survey almost
  // certain to appear after enough renders.
  const probabilityPassedRef = useRef(false)
  const lastEligibleSubmitCountRef = useRef<number | null>(null)
  const updateLastShownTime = useCallback((timestamp: number, submitCountValue: number) => {
    setFeedbackSurvey((prev) => {
      if (
        prev.timeLastShown === timestamp &&
        prev.submitCountAtLastAppearance === submitCountValue
      ) {
        return prev
      }
      return {
        timeLastShown: timestamp,
        submitCountAtLastAppearance: submitCountValue,
      }
    })
    // Persist cross-session pacing state (previously done by onChangeAppState observer)
    if (getGlobalConfig().feedbackSurveyState?.lastShownTime !== timestamp) {
      saveGlobalConfig((current) => ({
        ...current,
        feedbackSurveyState: {
          lastShownTime: timestamp,
        },
      }))
    }
  }, [])
  const onOpen = useCallback(
    (appearanceId: string) => {
      updateLastShownTime(Date.now(), submitCountRef.current)
      logEvent('zy_feedback_survey_event', {
        event_type: 'appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      void logOTelEvent('feedback_survey', {
        event_type: 'appeared',
        appearance_id: appearanceId,
        survey_type: surveyType,
      })
    },
    [updateLastShownTime, surveyType],
  )
  const onSelect = useCallback(
    (appearanceId_0: string, selected: FeedbackSurveyResponse) => {
      updateLastShownTime(Date.now(), submitCountRef.current)
      logEvent('zy_feedback_survey_event', {
        event_type: 'responded' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      void logOTelEvent('feedback_survey', {
        event_type: 'responded',
        appearance_id: appearanceId_0,
        response: selected,
        survey_type: surveyType,
      })
    },
    [updateLastShownTime, surveyType],
  )
  const { state, lastResponse, open, handleSelect } = useSurveyState({
    hideThanksAfterMs: config.hideThanksAfterMs,
    onOpen,
    onSelect,
  })
  const currentModel = getMainLoopModel()
  const isModelAllowed = useMemo(() => {
    if (config.onForModels.length === 0) {
      return false
    }
    if (config.onForModels.includes('*')) {
      return true
    }
    return config.onForModels.includes(currentModel!)
  }, [config.onForModels, currentModel])
  const shouldOpen = useMemo(() => {
    if (state !== 'closed') {
      return false
    }
    if (isLoading) {
      return false
    }

    // Don't show survey when permission or ask question prompts are visible
    if (hasActivePrompt) {
      return false
    }

    // Force display for testing
    if (process.env.CLAUDE_FORCE_DISPLAY_SURVEY && !feedbackSurvey.timeLastShown) {
      return true
    }
    if (!isModelAllowed) {
      return false
    }
    if (isEnvTruthy(process.env.ZY_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return false
    }
    if (isFeedbackSurveyDisabled()) {
      return false
    }

    // Check session-local pacing
    if (feedbackSurvey.timeLastShown) {
      // Check time elapsed since last appearance in this session
      const timeSinceLastShown = Date.now() - feedbackSurvey.timeLastShown
      if (timeSinceLastShown < config.minTimeBetweenFeedbackMs) {
        return false
      }
      // Check user turn requirement for subsequent appearances
      if (
        feedbackSurvey.submitCountAtLastAppearance !== null &&
        submitCount <
          feedbackSurvey.submitCountAtLastAppearance + config.minUserTurnsBetweenFeedback
      ) {
        return false
      }
    } else {
      // First appearance in this session
      const timeSinceSessionStart = Date.now() - sessionStartTime.current
      if (timeSinceSessionStart < config.minTimeBeforeFeedbackMs) {
        return false
      }
      if (submitCount < submitCountAtSessionStart.current + config.minUserTurnsBeforeFeedback) {
        return false
      }
    }

    // Probability check: roll once per eligibility window to avoid re-rolling
    // on every useMemo re-evaluation (which would make triggering near-certain).
    if (lastEligibleSubmitCountRef.current !== submitCount) {
      lastEligibleSubmitCountRef.current = submitCount
      probabilityPassedRef.current = Math.random() <= (settingsRate ?? config.probability)
    }
    if (!probabilityPassedRef.current) {
      return false
    }

    // Check global pacing (across all sessions)
    // Leave this till last because it reads from the filesystem which is expensive.
    const globalFeedbackState = getGlobalConfig().feedbackSurveyState
    if (globalFeedbackState?.lastShownTime) {
      const timeSinceGlobalLastShown = Date.now() - globalFeedbackState.lastShownTime
      if (timeSinceGlobalLastShown < config.minTimeBetweenGlobalFeedbackMs) {
        return false
      }
    }
    return true
  }, [
    state,
    isLoading,
    hasActivePrompt,
    isModelAllowed,
    feedbackSurvey.timeLastShown,
    feedbackSurvey.submitCountAtLastAppearance,
    submitCount,
    config.minTimeBetweenFeedbackMs,
    config.minTimeBetweenGlobalFeedbackMs,
    config.minUserTurnsBetweenFeedback,
    config.minTimeBeforeFeedbackMs,
    config.minUserTurnsBeforeFeedback,
    config.probability,
    settingsRate,
  ])
  useEffect(() => {
    if (shouldOpen) {
      open()
    }
  }, [shouldOpen, open])
  return {
    state,
    lastResponse,
    handleSelect,
  }
}
