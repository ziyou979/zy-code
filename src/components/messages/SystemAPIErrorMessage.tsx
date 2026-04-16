import * as React from 'react';
import { useState } from 'react';
import { Box, Text } from 'src/ink.js';
import { formatAPIError } from 'src/services/api/errorUtils.js';
import type { SystemAPIErrorMessage } from 'src/types/message.js';
import { useInterval } from 'usehooks-ts';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';
const MAX_API_ERROR_CHARS = 1000;
type Props = {
  message: SystemAPIErrorMessage;
  verbose: boolean;
};
export function SystemAPIErrorMessage({
  message,
  verbose
}: Props) {
  const {
    retryAttempt,
    error,
    retryInMs,
    maxRetries
  } = message;
  const hidden = retryAttempt < 4;
  const [countdownMs, setCountdownMs] = useState(0);
  const done = countdownMs >= retryInMs;
  useInterval(() => setCountdownMs(ms => ms + 1000), hidden || done ? null : 1000);
  if (hidden) {
    return null;
  }
  const second = Math.round((retryInMs - countdownMs) / 1000);
  const retryInSecondsLive = Math.max(0, second);
  const formatted = formatAPIError(error);
  let truncated= !verbose && formatted.length > MAX_API_ERROR_CHARS;
  const text = truncated ? formatted.slice(0, MAX_API_ERROR_CHARS) + "\u2026" : formatted;
  return <MessageResponse>{<Box flexDirection={"column"}>{<Text color={"error"}>{text}</Text>}{truncated && <CtrlOToExpand />}{<Text dimColor={true}>Retrying in {retryInSecondsLive}{" "}{retryInSecondsLive === 1 ? "second" : "seconds"}… (attempt{" "}{retryAttempt}/{maxRetries}){process.env.API_TIMEOUT_MS ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it` : ""}</Text>}</Box>}</MessageResponse>;
}
