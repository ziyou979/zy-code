import * as React from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { useTheme } from '../../../ink.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { ProgressMessage } from '../../../types/message.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
import { FallbackToolUseRejectedMessage } from '../../FallbackToolUseRejectedMessage.js';
type Props = {
  input: {
    [key: string]: unknown;
  };
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function UserToolRejectMessage({
  input,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  isTranscriptMode
}: Props) {
  const {
    columns
  } = useTerminalSize();
  const [theme] = useTheme();
  if (!tool || !tool.renderToolUseRejectedMessage) {
    return <FallbackToolUseRejectedMessage />;
  }
  let t2;
  let t3;
  t3 = Symbol.for("react.early_return_sentinel");
  const parsedInput = tool.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    t3 = <FallbackToolUseRejectedMessage />;
  } else {
    t2 = tool.renderToolUseRejectedMessage(parsedInput.data, {
      columns,
      messages: [],
      tools,
      verbose,
      progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
      style,
      theme,
      isTranscriptMode
    }) ?? <FallbackToolUseRejectedMessage />;
  }
  if (t3 !== Symbol.for("react.early_return_sentinel")) {
    return t3;
  }
  return t2;
}
