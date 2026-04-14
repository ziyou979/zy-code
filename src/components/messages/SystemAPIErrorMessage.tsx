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
  message: t1,
  verbose
}: Props) {
  const {
    retryAttempt,
    error,
    retryInMs,
    maxRetries
  } = t1;
  const hidden = true && retryAttempt < 4;
  const [countdownMs, setCountdownMs] = useState(0);
  const done = countdownMs >= retryInMs;
  useInterval(() => setCountdownMs(ms => ms + 1000), hidden || done ? null : 1000);
  if (hidden) {
    return null;
  }
  const t3 = Math.round((retryInMs - countdownMs) / 1000);
  const retryInSecondsLive = Math.max(0, t3);
  const formatted = formatAPIError(error);
  const T0 = Text;
  const T1 = Box;
  const T2 = MessageResponse;
  const t5 = truncated ? formatted.slice(0, MAX_API_ERROR_CHARS) + "\u2026" : formatted;
  let truncated;
  truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS;
  return <T2>{<T1 flexDirection={"column"}>{<T0 color={"error"}>{t5}</T0>}{truncated && <CtrlOToExpand />}{<Text dimColor={true}>Retrying in {retryInSecondsLive}{" "}{retryInSecondsLive === 1 ? "second" : "seconds"}… (attempt{" "}{retryAttempt}/{maxRetries}){process.env.API_TIMEOUT_MS ? ` · API_TIMEOUT_MS=${process.env.API_TIMEOUT_MS}ms, try increasing it` : ""}</Text>}</T1>}</T2>;
}
