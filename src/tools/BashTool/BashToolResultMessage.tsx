import React from 'react';
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { OutputLine } from '../../components/shell/OutputLine.js';
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js';
import { Box, Text } from '../../ink.js';
import type { Out as BashOut } from './BashTool.js';
type Props = {
  content: Omit<BashOut, 'interrupted'>;
  verbose: boolean;
  timeoutMs?: number;
};

// Pattern to match "Shell cwd was reset to <path>" message
// Use (?:^|\n) to match either start of string or after a newline
const SHELL_CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to .+)$/;

/**
 * Extracts sandbox violations from stderr if present
 * Returns both the cleaned stderr and the violations content
 */
function extractSandboxViolations(stderr: string): {
  cleanedStderr: string;
} {
  const violationsMatch = stderr.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/);
  if (!violationsMatch) {
    return {
      cleanedStderr: stderr
    };
  }

  // Remove the sandbox violations section from stderr
  const cleanedStderr = removeSandboxViolationTags(stderr).trim();
  return {
    cleanedStderr
  };
}

/**
 * Extracts the "Shell cwd was reset" warning message from stderr
 * Returns the cleaned stderr and the warning message separately
 */
function extractCwdResetWarning(stderr: string): {
  cleanedStderr: string;
  cwdResetWarning: string | null;
} {
  const match = stderr.match(SHELL_CWD_RESET_PATTERN);
  if (!match) {
    return {
      cleanedStderr: stderr,
      cwdResetWarning: null
    };
  }

  // Extract the warning message from capture group 1
  const cwdResetWarning = match[1] ?? null;
  // Remove the warning from stderr (replace the full match)
  const cleanedStderr = stderr.replace(SHELL_CWD_RESET_PATTERN, '').trim();
  return {
    cleanedStderr,
    cwdResetWarning
  };
}
export default function BashToolResultMessage({
  content,
  verbose,
  timeoutMs
}) {
  const {
    stdout: t2,
    stderr: t3,
    isImage,
    returnCodeInterpretation,
    noOutputExpected,
    backgroundTaskId
  } = content;
  const stdout = t2 === undefined ? "" : t2;
  const stdErrWithViolations = t3 === undefined ? "" : t3;
  let BoxComponent;

  let outputLineElement;
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const {
    cleanedStderr: stderrWithoutViolations
  } = extractSandboxViolations(stdErrWithViolations);
  let stderr: string;
  let cwdResetWarning: string | undefined;
  ({
    cleanedStderr: stderr,
    cwdResetWarning
  } = extractCwdResetWarning(stderrWithoutViolations));
  let outputLineElement2;
  if (isImage) {
    earlyReturn = <MessageResponse height={1}><Text dimColor={true}>[Image data detected and sent to ZY]</Text></MessageResponse>;
  } else {
    BoxComponent = Box;

    outputLineElement2 = stdout !== "" ? <OutputLine content={stdout} verbose={verbose} /> : null;
    outputLineElement = stderr.trim() !== "" ? <OutputLine content={stderr} verbose={verbose} isError={true} /> : null;
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  const messageResponseElement = stdout === "" && stderr.trim() === "" && !cwdResetWarning ? <MessageResponse height={1}><Text dimColor={true}>{backgroundTaskId ? <>Running in the background{" "}<KeyboardShortcutHint shortcut={"\u2193"} action="manage" parens={true} /></> : returnCodeInterpretation || (noOutputExpected ? "Done" : "(No output)")}</Text></MessageResponse> : null;
  return <BoxComponent flexDirection={"column"}>{outputLineElement2}{outputLineElement}{cwdResetWarning ? <MessageResponse><Text dimColor={true}>{cwdResetWarning}</Text></MessageResponse> : null}{messageResponseElement}{timeoutMs && <MessageResponse><ShellTimeDisplay timeoutMs={timeoutMs} /></MessageResponse>}</BoxComponent>;
}