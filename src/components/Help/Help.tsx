import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from 'src/i18n/index.js'
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js'
import { builtInCommandNames, type Command, type CommandResultDisplay } from '../../commands.js'
import { useIsInsideModal } from '../../context/ModalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Link, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { Pane } from '../design-system/Pane.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { Commands } from './Commands.js'
import { General } from './General.js'

type Props = {
  onClose: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  commands: Command[]
}
export function Help({ onClose, commands }: Props) {
  const { rows, columns } = useTerminalSize()
  const maxHeight = Math.floor(rows / 2)
  const insideModal = useIsInsideModal()
  const close = () =>
    onClose('Help dialog dismissed', {
      display: 'system',
    })
  useKeybinding('help:dismiss', close, {
    context: 'Help',
  })
  const exitState = useExitOnCtrlCDWithKeybindings(close)
  const dismissShortcut = useShortcutDisplay('help:dismiss', 'Help', 'esc')
  const builtinNames = builtInCommandNames()
  const builtinCommands = commands.filter((cmd) => builtinNames.has(cmd.name) && !cmd.isHidden)
  const customCommands = commands.filter((cmd) => !builtinNames.has(cmd.name) && !cmd.isHidden)
  const tabs = [
    <Tab key="general" title={tSync('help.tabGeneral')}>
      <General />
    </Tab>,
  ]
  tabs.push(
    <Tab key="commands" title={tSync('help.tabCommands')}>
      <Commands
        commands={builtinCommands}
        maxHeight={maxHeight}
        columns={columns}
        title={tSync('help.browseDefaultCommands')}
        onCancel={close}
      />
    </Tab>,
  )
  tabs.push(
    <Tab key="custom" title={tSync('help.tabCustomCommands')}>
      <Commands
        commands={customCommands}
        maxHeight={maxHeight}
        columns={columns}
        title={tSync('help.browseCustomCommands')}
        emptyMessage={tSync('help.noCustomCommands')}
        onCancel={close}
      />
    </Tab>,
  )
  return (
    <Box flexDirection="column" height={insideModal ? undefined : maxHeight}>
      {
        <Pane color="professionalBlue">
          {
            <Tabs title={'/help'} color="professionalBlue" defaultTab="general">
              {tabs}
            </Tabs>
          }
          {
            <Box marginTop={1}>
              <Text>
                {tSync('help.forMoreHelp')} <Link url="https://code.zy.com/docs/en/overview" />
              </Text>
            </Box>
          }
          {
            <Box marginTop={1}>
              <Text dimColor={true}>
                {exitState.pending ? (
                  tSync('help.pressAgainToExit', { keyName: exitState.keyName ?? '' })
                ) : (
                  <Text italic={true}>
                    {dismissShortcut} {tSync('help.toCancel')}
                  </Text>
                )}
              </Text>
            </Box>
          }
        </Pane>
      }
    </Box>
  )
}
