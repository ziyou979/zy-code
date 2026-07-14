import { basename, relative } from 'node:path'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { isSupportedVSCodeTerminal } from '../services/ide/ide.js'
import { Select } from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'
import type {
  PermissionOption,
  PermissionOptionWithLabel,
} from './permissions/FilePermissionDialog/PermissionOptions.js'

type Props<A> = {
  filePath: string
  input: A
  onChange: (option: PermissionOption, args: A, feedback?: string) => void
  options: PermissionOptionWithLabel[]
  ideName: string
  symlinkTarget?: string | null
  rejectFeedback: string
  acceptFeedback: string
  setFocusedOption: (value: string) => void
  onInputModeToggle: (value: string) => void
  focusedOption: string
  yesInputMode: boolean
  noInputMode: boolean
}
export function ShowInIDEPrompt({
  onChange,
  options,
  input,
  filePath,
  ideName,
  symlinkTarget,
  rejectFeedback,
  acceptFeedback,
  setFocusedOption,
  onInputModeToggle,
  focusedOption,
  yesInputMode,
  noInputMode,
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
}: Props<any>) {
  const saveFileHint = isSupportedVSCodeTerminal() && (
    <Text dimColor={true}>{tSync('permission.saveFileToContinue')}</Text>
  )
  const fileName = basename(filePath)
  const symlinkWarningText =
    symlinkTarget &&
    (relative(getCwd(), symlinkTarget).startsWith('..')
      ? tSync('permission.symlinkModifyOutside', { symlinkTarget })
      : tSync('permission.symlinkTarget', { symlinkTarget }))
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        {
          <Text bold={true} color="permission">
            {tSync('permission.openedChangesInIDE', { ideName })} ⧉
          </Text>
        }
        {symlinkWarningText && <Text color="warning">{symlinkWarningText}</Text>}
        {saveFileHint}
        {
          <Box flexDirection="column">
            {<Text>{tSync('permission.doYouWantToMakeThisEdit', { filename: fileName })}</Text>}
            {
              <Select
                options={options}
                inlineDescriptions={true}
                onChange={(value: string) => {
                  const selected = options.find((opt) => opt.value === value)
                  if (selected) {
                    if (selected.option.type === 'reject') {
                      const trimmedFeedback = rejectFeedback.trim()
                      onChange(selected.option, input, trimmedFeedback || undefined)
                      return
                    }
                    if (selected.option.type === 'accept-once') {
                      const trimmedFeedback_0 = acceptFeedback.trim()
                      onChange(selected.option, input, trimmedFeedback_0 || undefined)
                      return
                    }
                    onChange(selected.option, input)
                  }
                }}
                onCancel={() =>
                  onChange(
                    {
                      type: 'reject',
                    },
                    input,
                  )
                }
                onFocus={(optionValue: string) => setFocusedOption(optionValue)}
                onInputModeToggle={onInputModeToggle}
              />
            }
          </Box>
        }
        {
          <Box marginTop={1}>
            <Text dimColor={true}>
              {tSync('permission.escToCancel', { cancel: tSync('permission.cancel') })}
              {((focusedOption === 'yes' && !yesInputMode) ||
                (focusedOption === 'no' && !noInputMode)) &&
                ` · ${tSync('permission.tabToAmend', { amend: tSync('permission.amend') })}`}
            </Text>
          </Box>
        }
      </Box>
    </Pane>
  )
}
