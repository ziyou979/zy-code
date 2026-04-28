import type { TextBlock } from '../../types/llm.js';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';
type Props = {
  addMargin: boolean;
  param: TextBlock;
};
export function UserBashInputMessage({
  param,
  addMargin
}: Props) {
  const {
    text
  } = param;
  const input = extractTag(text, "bash-input");
  if (!input) {
    return null;
  }
  return <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor="bashMessageBackgroundColor" paddingRight={1}>{<Text color="bashBorder">! </Text>}{<Text color="text">{input}</Text>}</Box>;
}
