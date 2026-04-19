import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';
import { getPlatform } from 'src/utils/platform.js';
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { getNewlineInstructions } from './utils.js';
import { tSync } from '../../i18n/index.js';

/** Format a shortcut for display in the help menu (e.g., "ctrl+o" → "ctrl + o") */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ');
}
export function PromptInputHelpMenu(props) {
  const {
    dimColor,
    fixedWidth,
    gap,
    paddingX
  } = props;
  const t0 = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const transcriptShortcut = formatShortcut(t0);
  const t2 = useShortcutDisplay("app:toggleTodos", "Global", "ctrl+t");
  const todosShortcut = formatShortcut(t2);
  const t4 = useShortcutDisplay("chat:undo", "Chat", "ctrl+_");
  const undoShortcut = formatShortcut(t4);
  const t6 = useShortcutDisplay("chat:stash", "Chat", "ctrl+s");
  const stashShortcut = formatShortcut(t6);
  const t8 = useShortcutDisplay("chat:cycleMode", "Chat", "shift+tab");
  const cycleModeShortcut = formatShortcut(t8);
  const t10 = useShortcutDisplay("chat:modelPicker", "Chat", "alt+p");
  const modelPickerShortcut = formatShortcut(t10);
  const t14 = useShortcutDisplay("chat:externalEditor", "Chat", "ctrl+g");
  const externalEditorShortcut = formatShortcut(t14);
  const t16 = useShortcutDisplay("app:toggleTerminal", "Global", "meta+j");
  const terminalShortcut = formatShortcut(t16);
  const t18 = useShortcutDisplay("chat:imagePaste", "Chat", "ctrl+v");
  const imagePasteShortcut = formatShortcut(t18);
  const terminalShortcutElement = feature("TERMINAL_PANEL") ? getFeatureValue_CACHED_MAY_BE_STALE("tengu_terminal_panel", false) ? <Box><Text dimColor={dimColor}>{tSync('help.terminal', { shortcut: terminalShortcut })}</Text></Box> : null : null;
  const t33 = getNewlineInstructions();
  const t37 = getPlatform() !== "windows" && <Box><Text dimColor={dimColor}>{tSync('help.suspend')}</Text></Box>;
  const t43 = isKeybindingCustomizationEnabled() && <Box><Text dimColor={dimColor}>{tSync('help.customizeKeybindings')}</Text></Box>;
  return <Box paddingX={paddingX} flexDirection="row" gap={gap}>{<Box flexDirection="column" width={fixedWidth ? 24 : undefined}>{<Box><Text dimColor={dimColor}>{tSync('help.bashMode')}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.commands')}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.filePaths')}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.background')}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.sideQuestion')}</Text></Box>}</Box>}{<Box flexDirection="column" width={fixedWidth ? 35 : undefined}>{<Box><Text dimColor={dimColor}>{tSync('help.clearInput')}</Text></Box>}{<Box><Text dimColor={dimColor}>{cycleModeShortcut}{" "}{tSync('help.cycleModeAction')}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.verboseOutput', { shortcut: transcriptShortcut })}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.toggleTasks', { shortcut: todosShortcut })}</Text></Box>}{terminalShortcutElement}{<Box><Text dimColor={dimColor}>{t33}</Text></Box>}</Box>}{<Box flexDirection="column">{<Box><Text dimColor={dimColor}>{tSync('help.undo', { shortcut: undoShortcut })}</Text></Box>}{t37}{<Box><Text dimColor={dimColor}>{tSync('help.pasteImages', { shortcut: imagePasteShortcut })}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.switchModel', { shortcut: modelPickerShortcut })}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.stashPrompt', { shortcut: stashShortcut })}</Text></Box>}{<Box><Text dimColor={dimColor}>{tSync('help.externalEditor', { shortcut: externalEditorShortcut })}</Text></Box>}{t43}</Box>}</Box>;
}
