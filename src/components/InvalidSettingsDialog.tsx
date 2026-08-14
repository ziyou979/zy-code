import { Text } from '../ink/index.js'
import type { ValidationError } from '../services/settings/validation.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { ValidationErrorsList } from './ValidationErrorsList.js'

type Props = {
  settingsErrors: ValidationError[]
  onContinue: () => void
  onExit: () => void
}

/**
 * settings 文件存在校验错误时显示的 dialog。
 * 用户必须选择继续（跳过无效文件）或退出并修复。
 */
export function InvalidSettingsDialog({ settingsErrors, onContinue, onExit }: Props) {
  const handleSelect = function handleSelect(value: string) {
    if (value === 'exit') {
      onExit()
    } else {
      onContinue()
    }
  }
  return (
    <Dialog title="Settings Error" onCancel={onExit} color="warning">
      {<ValidationErrorsList errors={settingsErrors} />}
      {
        <Text dimColor={true}>
          Files with errors are skipped entirely, not just the invalid settings.
        </Text>
      }
      {
        <Select
          options={[
            {
              label: 'Exit and fix manually',
              value: 'exit',
            },
            {
              label: 'Continue without these settings',
              value: 'continue',
            },
          ]}
          onChange={handleSelect}
        />
      }
    </Dialog>
  )
}
