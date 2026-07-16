import { feature } from 'bun:bundle'
import { Box, Text } from 'src/ink/index.js'
import { getPlatform } from 'src/services/shell/platform.js'
import { tSync } from '../../i18n/index.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getNewlineInstructions } from './utils.js'

/** Format a shortcut for display in the help menu (e.g., "ctrl+o" → "ctrl + o") */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ')
}
export function PromptInputHelpMenu(props: {
  dimColor?: boolean
  fixedWidth?: number | boolean
  gap?: number
  paddingX?: number
}) {
  const { dimColor, fixedWidth, gap, paddingX } = props
  const transcriptShortcutRaw = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const transcriptShortcut = formatShortcut(transcriptShortcutRaw)
  const todosShortcutRaw = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t')
  const todosShortcut = formatShortcut(todosShortcutRaw)
  const undoShortcutRaw = useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_')
  const undoShortcut = formatShortcut(undoShortcutRaw)
  const stashShortcutRaw = useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s')
  const stashShortcut = formatShortcut(stashShortcutRaw)
  const cycleModeShortcutRaw = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')
  const cycleModeShortcut = formatShortcut(cycleModeShortcutRaw)
  const modelPickerShortcutRaw = useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p')
  const modelPickerShortcut = formatShortcut(modelPickerShortcutRaw)
  const externalEditorShortcutRaw = useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g')
  const externalEditorShortcut = formatShortcut(externalEditorShortcutRaw)
  const terminalShortcutRaw = useShortcutDisplay('app:toggleTerminal', 'Global', 'meta+j')
  const terminalShortcut = formatShortcut(terminalShortcutRaw)
  const imagePasteShortcutRaw = useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')
  const imagePasteShortcut = formatShortcut(imagePasteShortcutRaw)
  const terminalShortcutElement = feature('TERMINAL_PANEL') ? (
    getFeatureValue_CACHED_MAY_BE_STALE('zy_terminal_panel', false) ? (
      <Box>
        <Text dimColor={dimColor}>{tSync('help.terminal', { shortcut: terminalShortcut })}</Text>
      </Box>
    ) : null
  ) : null
  const newlineInstructions = getNewlineInstructions()
  const suspendElement = getPlatform() !== 'windows' && (
    <Box>
      <Text dimColor={dimColor}>{tSync('help.suspend')}</Text>
    </Box>
  )
  const customizeKeybindingsElement = isKeybindingCustomizationEnabled() && (
    <Box>
      <Text dimColor={dimColor}>{tSync('help.customizeKeybindings')}</Text>
    </Box>
  )
  return (
    <Box paddingX={paddingX} flexDirection="row" gap={gap}>
      {
        <Box flexDirection="column" width={fixedWidth ? 24 : undefined}>
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.bashMode')}</Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.commands')}</Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.filePaths')}</Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.background')}</Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.sideQuestion')}</Text>
            </Box>
          }
        </Box>
      }
      {
        <Box flexDirection="column" width={fixedWidth ? 35 : undefined}>
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.clearInput')}</Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {cycleModeShortcut} {tSync('help.cycleModeAction')}
              </Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.verboseOutput', { shortcut: transcriptShortcut })}
              </Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.toggleTasks', { shortcut: todosShortcut })}
              </Text>
            </Box>
          }
          {terminalShortcutElement}
          {
            <Box>
              <Text dimColor={dimColor}>{newlineInstructions}</Text>
            </Box>
          }
        </Box>
      }
      {
        <Box flexDirection="column">
          {
            <Box>
              <Text dimColor={dimColor}>{tSync('help.undo', { shortcut: undoShortcut })}</Text>
            </Box>
          }
          {suspendElement}
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.pasteImages', { shortcut: imagePasteShortcut })}
              </Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.switchModel', { shortcut: modelPickerShortcut })}
              </Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.stashPrompt', { shortcut: stashShortcut })}
              </Text>
            </Box>
          }
          {
            <Box>
              <Text dimColor={dimColor}>
                {tSync('help.externalEditor', { shortcut: externalEditorShortcut })}
              </Text>
            </Box>
          }
          {customizeKeybindingsElement}
        </Box>
      }
    </Box>
  )
}
