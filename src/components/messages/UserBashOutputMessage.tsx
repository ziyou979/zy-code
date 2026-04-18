import * as React from 'react';
import BashToolResultMessage from '../../tools/BashTool/BashToolResultMessage.js';
import { extractTag } from '../../utils/messages.js';
export function UserBashOutputMessage({
  content,
  verbose
}) {
  const rawStdout = extractTag(content, "bash-stdout") ?? "";
  const stdout = extractTag(rawStdout, "persisted-output") ?? rawStdout;
  const stderr = extractTag(content, "bash-stderr") ?? "";
  // @ts-ignore
  return <BashToolResultMessage content={{
    stdout,
    stderr
  }} verbose={!!verbose} />;
}
