import { useEffect, useRef, useState } from 'react'
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { shouldUseSessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { logOTelEvent } from '../../services/telemetry/events.js'
import type { Message } from '../../types/message.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isCompactBoundaryMessage } from '../../services/messages/index.js'
import { useSurveyState } from './useSurveyState.js'

const HIDE_THANKS_AFTER_MS = 3000
const POST_COMPACT_SURVEY_GATE = 'zy_post_compact_survey'
const SURVEY_PROBABILITY = 0.2 // Show survey 20% of the time after compaction

function hasMessageAfterBoundary(messages: Message[], boundaryUuid: string): boolean {
  const boundaryIndex = messages.findIndex((msg) => msg.uuid === boundaryUuid)
  if (boundaryIndex === -1) {
    return false
  }

  // Check if there's a user or assistant message after the boundary
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg && (msg.type === 'user' || msg.type === 'assistant')) {
      return true
    }
  }
  return false
}
export function usePostCompactSurvey(
  messages: Message[],
  isLoading: boolean,
  hasActivePromptParam: boolean | undefined,
  surveyConfig: { enabled?: boolean } | undefined,
) {
  const hasActivePrompt = hasActivePromptParam === undefined ? false : hasActivePromptParam
  const { enabled: surveyEnabled } = surveyConfig === undefined ? {} : surveyConfig
  const enabled = surveyEnabled === undefined ? true : surveyEnabled
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(null)
  const initialBoundarySet = new Set()
  const seenCompactBoundaries = useRef(initialBoundarySet)
  const pendingCompactBoundaryUuid = useRef<string | null>(null)
  const onOpen = (appearanceId: string) => {
    const smCompactionEnabled = shouldUseSessionMemoryCompaction()
    logEvent('zy_post_compact_survey_event', {
      event_type: 'appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      session_memory_compaction_enabled:
        smCompactionEnabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logOTelEvent('feedback_survey', {
      event_type: 'appeared',
      appearance_id: appearanceId,
      survey_type: 'post_compact',
    })
  }
  const onSelect = (appearanceId_0: string, selected: string) => {
    const smCompactionEnabled_0 = shouldUseSessionMemoryCompaction()
    logEvent('zy_post_compact_survey_event', {
      event_type: 'responded' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      session_memory_compaction_enabled:
        smCompactionEnabled_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logOTelEvent('feedback_survey', {
      event_type: 'responded',
      appearance_id: appearanceId_0,
      response: selected,
      survey_type: 'post_compact',
    })
  }
  const { state, lastResponse, open, handleSelect } = useSurveyState({
    hideThanksAfterMs: HIDE_THANKS_AFTER_MS,
    onOpen,
    onSelect,
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    setGateEnabled(checkStatsigFeatureGate_CACHED_MAY_BE_STALE(POST_COMPACT_SURVEY_GATE))
  }, [enabled])
  const currentCompactBoundaries = new Set(
    messages.filter((msg) => isCompactBoundaryMessage(msg)).map((msg_0) => msg_0.uuid),
  )
  useEffect(() => {
    if (!enabled) {
      return
    }
    if (state !== 'closed' || isLoading) {
      return
    }
    if (hasActivePrompt) {
      return
    }
    if (gateEnabled !== true) {
      return
    }
    if (isFeedbackSurveyDisabled()) {
      return
    }
    if (isEnvTruthy(process.env.ZY_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return
    }
    if (pendingCompactBoundaryUuid.current !== null) {
      if (hasMessageAfterBoundary(messages, pendingCompactBoundaryUuid.current)) {
        pendingCompactBoundaryUuid.current = null
        if (Math.random() < SURVEY_PROBABILITY) {
          open()
        }
        return
      }
    }
    const newBoundaries = Array.from(currentCompactBoundaries).filter(
      (uuid) => !seenCompactBoundaries.current.has(uuid),
    )
    if (newBoundaries.length > 0) {
      seenCompactBoundaries.current = new Set(currentCompactBoundaries)
      pendingCompactBoundaryUuid.current = newBoundaries[newBoundaries.length - 1]
    }
  }, [
    enabled,
    currentCompactBoundaries,
    state,
    isLoading,
    hasActivePrompt,
    gateEnabled,
    messages,
    open,
  ])
  return {
    state,
    lastResponse,
    handleSelect,
  }
}
