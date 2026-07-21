import { feature } from 'bun:bundle'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { Box, Text, usePreviewTheme, useTheme, useThemeSetting } from '../ink/index.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { gracefulShutdown } from '../bootstrap/lifecycle/gracefulShutdown.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import type { ThemeSetting } from '../services/environment/theme.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { getColorModuleUnavailableReason, getSyntaxTheme } from './StructuredDiff/colorDiff.js'
import { StructuredDiff } from './StructuredDiff.js'
export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  /** Skip exit handling when running in a context that already has it (e.g., onboarding) */
  skipExitHandling?: boolean
  /** Called when the user cancels (presses Escape). If skipExitHandling is true and this is provided, it will be called instead of just saving the preview. */
  onCancel?: () => void
}
export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
}: ThemePickerProps) {
  const [theme] = useTheme()
  const themeSetting = useThemeSetting()
  const { columns } = useTerminalSize()
  const colorModuleUnavailableReason = getColorModuleUnavailableReason()
  const syntaxTheme = colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()
  const syntaxHighlightingDisabled =
    useAppState((s) => s.settings.syntaxHighlightingDisabled) ?? false
  const setAppState = useSetAppState()
  useRegisterKeybindingContext('ThemePicker')
  const syntaxToggleShortcut = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
    'ctrl+t',
  )
  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        const newValue = !syntaxHighlightingDisabled
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: newValue,
        })
        setAppState((prev) => ({
          ...prev,
          settings: {
            ...prev.settings,
            syntaxHighlightingDisabled: newValue,
          },
        }))
      }
    },
    {
      context: 'ThemePicker',
    },
  )
  const exitState = useExitOnCtrlCDWithKeybindings(skipExitHandling ? _temp2 : undefined)
  const themeOptions = [
    ...(feature('AUTO_THEME')
      ? [
          {
            label: tSync('themePicker.auto'),
            value: 'auto' as const,
          },
        ]
      : []),
    {
      label: tSync('themePicker.dark'),
      value: 'dark',
    },
    {
      label: tSync('themePicker.light'),
      value: 'light',
    },
    {
      label: tSync('themePicker.darkDaltonized'),
      value: 'dark-daltonized',
    },
    {
      label: tSync('themePicker.lightDaltonized'),
      value: 'light-daltonized',
    },
    {
      label: tSync('themePicker.darkAnsi'),
      value: 'dark-ansi',
    },
    {
      label: tSync('themePicker.lightAnsi'),
      value: 'light-ansi',
    },
  ]
  const content = (
    <Box flexDirection="column" gap={1}>
      {
        <Box flexDirection="column" gap={1}>
          {showIntroText ? (
            <Text>{tSync('themePicker.intro')}</Text>
          ) : (
            <Text bold={true} color="permission">
              {tSync('themePicker.title')}
            </Text>
          )}
          {
            <Box flexDirection="column">
              {<Text bold={true}>{tSync('themePicker.chooseStyle')}</Text>}
              {helpText && !showHelpTextBelow && <Text dimColor={true}>{helpText}</Text>}
            </Box>
          }
          {
            <Select
              options={themeOptions}
              onFocus={(setting: string) => {
                setPreviewTheme(setting as ThemeSetting)
              }}
              onChange={(setting_0: string) => {
                savePreview()
                onThemeSelect(setting_0 as ThemeSetting)
              }}
              onCancel={
                skipExitHandling
                  ? () => {
                      cancelPreview()
                      onCancelProp?.()
                    }
                  : async () => {
                      cancelPreview()
                      await gracefulShutdown(0)
                    }
              }
              visibleOptionCount={themeOptions.length}
              defaultValue={themeSetting}
              defaultFocusValue={themeSetting}
            />
          }
        </Box>
      }
      {
        <Box flexDirection="column" width="100%">
          {
            <Box
              flexDirection="column"
              borderTop={true}
              borderBottom={true}
              borderLeft={false}
              borderRight={false}
              borderStyle="dashed"
              borderColor="subtle"
            >
              <StructuredDiff
                patch={{
                  oldStart: 1,
                  newStart: 1,
                  oldLines: 3,
                  newLines: 3,
                  lines: [
                    ' function greet() {',
                    '-  console.log("Hello, World!");',
                    '+  console.log("Hello, Zy!");',
                    ' }',
                  ],
                }}
                dim={false}
                filePath="demo.js"
                firstLine={null}
                width={columns}
              />
            </Box>
          }
          {
            <Text dimColor={true}>
              {' '}
              {colorModuleUnavailableReason === 'env'
                ? tSync('themePicker.syntaxUnavailable', {
                    envVar: `ZY_CODE_SYNTAX_HIGHLIGHT=${process.env.ZY_CODE_SYNTAX_HIGHLIGHT}`,
                  })
                : syntaxHighlightingDisabled
                  ? tSync('themePicker.syntaxDisabled', { shortcut: syntaxToggleShortcut })
                  : syntaxTheme
                    ? syntaxTheme.source
                      ? tSync('themePicker.syntaxTheme', {
                          themeName: syntaxTheme.theme,
                          source: syntaxTheme.source,
                          shortcut: syntaxToggleShortcut,
                        })
                      : tSync('themePicker.syntaxThemeSimple', {
                          themeName: syntaxTheme.theme,
                          shortcut: syntaxToggleShortcut,
                        })
                    : tSync('themePicker.syntaxEnabled', { shortcut: syntaxToggleShortcut })}
            </Text>
          }
        </Box>
      }
    </Box>
  )
  if (!showIntroText) {
    return (
      <>
        {<Box flexDirection="column">{content}</Box>}
        {
          <Box marginTop={1}>
            {showHelpTextBelow && helpText && (
              <Box marginLeft={3}>
                <Text dimColor={true}>{helpText}</Text>
              </Box>
            )}
            {!hideEscToCancel && (
              <Box>
                <Text dimColor={true} italic={true}>
                  {exitState.pending ? (
                    tSync('themePicker.exitAgain', { key: exitState.keyName ?? '' })
                  ) : (
                    <Byline>
                      <KeyboardShortcutHint shortcut="Enter" action="select" />
                      <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                    </Byline>
                  )}
                </Text>
              </Box>
            )}
          </Box>
        }
      </>
    )
  }
  return content
}
function _temp2() {}
