import React from 'react';
import { stringWidth } from '../ink/stringWidth.js';
import { Box, Text } from '../ink.js';
import type { NormalizedMessage } from '../types/message.js';
type Props = {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
};
export function MessageModel({
  message,
  isTranscriptMode
}: Props) {
  const shouldShowModel = isTranscriptMode && message.type === "assistant" && message.message.model && message.message.content.some(c => c.type === "text");
  if (!shouldShowModel) {
    return null;
  }
  const t1 = stringWidth(message.message.model) + 8;
  return <Box minWidth={t1}>{<Text dimColor={true}>{message.message.model}</Text>}</Box>;
}
