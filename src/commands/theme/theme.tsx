import type { CommandResultDisplay } from '../../commands/index.js'
import { tSync } from '../../i18n/index.js'
import { Pane } from '../../components/design-system/Pane.js'
import { ThemePicker } from '../../components/ThemePicker.js'
import { useTheme } from '../../ink/index.js'
import type { LocalJSXCommandCall } from '../types.js'

type Props = {
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
function ThemePickerCommand({ onDone }: Props) {
  const [, setTheme] = useTheme()
  return (
    <Pane color="permission">
      <ThemePicker
        onThemeSelect={(setting) => {
          setTheme(setting)
          onDone(tSync('commands.out.theme.set', { theme: setting }))
        }}
        onCancel={() => {
          onDone(tSync('commands.out.theme.dismissed'), {
            display: 'system',
          })
        }}
        skipExitHandling={true}
      />
    </Pane>
  )
}
export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <ThemePickerCommand onDone={onDone} />
}
