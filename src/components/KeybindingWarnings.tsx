import React from 'react';
import { Box, Text } from '../ink.js';
import { getCachedKeybindingWarnings, getKeybindingsPath, isKeybindingCustomizationEnabled } from '../keybindings/loadUserBindings.js';

/**
 * Displays keybinding validation warnings in the UI.
 * Similar to McpParsingWarnings, this provides persistent visibility
 * of configuration issues.
 *
 * Only shown when keybinding customization is enabled (ant users + feature gate).
 */
export function KeybindingWarnings() {
  if (!isKeybindingCustomizationEnabled()) {
    return null;
  }
  let boxElement;
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const warnings = getCachedKeybindingWarnings();
  if (warnings.length === 0) {
    earlyReturn = null;
  } else {
    const errors = warnings.filter((w) => w.severity === "error");
    const warns = warnings.filter((w_0) => w_0.severity === "warning");
    boxElement = <Box flexDirection="column" marginTop={1} marginBottom={1}><Text bold={true} color={errors.length > 0 ? "error" : "warning"}>Keybinding Configuration Issues</Text><Box><Text dimColor={true}>Location: </Text><Text dimColor={true}>{getKeybindingsPath()}</Text></Box><Box marginLeft={1} flexDirection="column" marginTop={1}>{errors.map((error, i) => <Box key={`error-${i}`} flexDirection="column"><Box><Text dimColor={true}>└ </Text><Text color="error">[Error]</Text><Text dimColor={true}> {error.message}</Text></Box>{error.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {error.suggestion}</Text></Box>}</Box>)}{warns.map((warning, i_0) => <Box key={`warning-${i_0}`} flexDirection="column"><Box><Text dimColor={true}>└ </Text><Text color="warning">[Warning]</Text><Text dimColor={true}> {warning.message}</Text></Box>{warning.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {warning.suggestion}</Text></Box>}</Box>)}</Box></Box>;
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return boxElement;
}