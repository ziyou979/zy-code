import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { tSync } from '../i18n/index.js';
import { Box, Text } from '../ink.js';
import type { Screen } from '../screens/REPL.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../utils/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MessageResponse } from './MessageResponse.js';
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};
export function CompactSummary({
  message,
  screen
}: Props) {
  const isTranscriptMode = screen === "transcript";
  const textContent = getUserMessageText(message) || "";
  const metadata = message.summarizeMetadata;
  if (metadata) {
    return <Box flexDirection="column" marginTop={1}><Box flexDirection="row">{<Box minWidth={2}><Text color="text">{BLACK_CIRCLE}</Text></Box>}<Box flexDirection="column">{<Text bold={true}>{tSync('compactSummary.summarizedConversation')}</Text>}{!isTranscriptMode && <MessageResponse><Box flexDirection="column"><Text dimColor={true}>{tSync('compactSummary.summarizedMessages', { count: metadata.messagesSummarized })}{" "}{(metadata.direction as any) === "up_to" ? tSync('compactSummary.upToPoint') : tSync('compactSummary.fromPoint')}</Text>{metadata.userContext && <Text dimColor={true}>{tSync('compactSummary.contextLabel')}: {"\u201C"}{metadata.userContext}{"\u201D"}</Text>}<Text dimColor={true}><ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description={tSync('compactSummary.expandHistory')} parens={true} /></Text></Box></MessageResponse>}{isTranscriptMode && <MessageResponse><Text>{textContent}</Text></MessageResponse>}</Box></Box></Box>;
  }
  return <Box flexDirection="column" marginTop={1}>{<Box flexDirection="row">{<Box minWidth={2}><Text color="text">{BLACK_CIRCLE}</Text></Box>}<Box flexDirection="column"><Text bold={true}>{tSync('compactSummary.title')}{!isTranscriptMode && <Text dimColor={true}>{" "}<ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description={tSync('compactSummary.expand')} parens={true} /></Text>}</Text></Box></Box>}{isTranscriptMode && <MessageResponse><Text>{textContent}</Text></MessageResponse>}</Box>;
}
