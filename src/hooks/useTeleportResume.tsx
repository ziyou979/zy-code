import { useState } from 'react';
import { setTeleportedSessionInfo } from 'src/bootstrap/state.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { errorMessage, TeleportOperationError } from '../utils/errors.js';
import { teleportResumeCodeSession } from '../utils/teleport.js';
export type TeleportResumeError = {
  message: string;
  formattedMessage?: string;
  isOperationError: boolean;
};
export type TeleportSource = 'cliArg' | 'localCommand';
export function useTeleportResume(source) {
  const [isResuming, setIsResuming] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const resumeSession = async session => {
    setIsResuming(true);
    setError(null);
    setSelectedSession(session);
    logEvent("zy_teleport_resume_session", {
      source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      session_id: session.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    try {
      const result = await teleportResumeCodeSession(session.id);
      setTeleportedSessionInfo({
        sessionId: session.id
      });
      setIsResuming(false);
      return result;
    } catch (err) {
      const teleportError = {
        message: err instanceof TeleportOperationError ? err.message : errorMessage(err),
        formattedMessage: err instanceof TeleportOperationError ? err.formattedMessage : undefined,
        isOperationError: err instanceof TeleportOperationError
      };
      setError(teleportError);
      setIsResuming(false);
      return null;
    }
  };
  const clearError = () => {
    setError(null);
  };
  return {
    resumeSession,
    isResuming,
    error,
    selectedSession,
    clearError
  };
}
