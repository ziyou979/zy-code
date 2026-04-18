import type { Message } from '../../types/message.js'

/**
 * React Hook for detecting user frustration from conversation patterns.
 * This is a stub implementation for external builds.
 */
export function useFrustrationDetection(
  messages: readonly Message[],
  isLoading: boolean,
  hasActivePrompt: boolean,
  isSurveyOpen: boolean,
): {
  state: 'closed'
  handleTranscriptSelect: () => void
} {
  // Stub: always returns closed state in external builds
  return {
    state: 'closed',
    handleTranscriptSelect: () => {},
  }
}
