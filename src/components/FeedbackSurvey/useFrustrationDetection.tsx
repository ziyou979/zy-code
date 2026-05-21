import type { Message } from '../../types/message.js'

/**
 * React Hook for detecting user frustration from conversation patterns.
 * This is a stub implementation for external builds.
 */
export function useFrustrationDetection(
  _messages: readonly Message[],
  _isLoading: boolean,
  _hasActivePrompt: boolean,
  _isSurveyOpen: boolean,
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
