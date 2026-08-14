import { tSync } from 'src/i18n/index.js'
import { Text } from '../ink/index.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel'
type Props = {
  currentVersion: string
  onChoice: (choice: ChannelDowngradeChoice) => void
}

/**
 * 从 latest channel 切换到 stable channel 时显示的 dialog。
 * 让用户选择降级或保留当前版本。
 */
export function ChannelDowngradeDialog({ currentVersion, onChoice }: Props) {
  const handleSelect = function handleSelect(value: string) {
    onChoice(value as ChannelDowngradeChoice)
  }
  const handleCancel = function handleCancel() {
    onChoice('cancel')
  }
  return (
    <Dialog
      title={tSync('channel.downgradeTitle')}
      onCancel={handleCancel}
      color="permission"
      hideBorder={true}
      hideInputGuide={true}
    >
      {<Text>{tSync('channel.downgradeDescription', { currentVersion })}</Text>}
      {<Text dimColor={true}>{tSync('channel.howToHandle')}</Text>}
      {
        <Select
          options={[
            {
              label: tSync('channel.allowDowngrade'),
              value: 'downgrade' as ChannelDowngradeChoice,
            },
            {
              label: tSync('channel.stayOnCurrent', { currentVersion }),
              value: 'stay' as ChannelDowngradeChoice,
            },
          ]}
          onChange={handleSelect}
        />
      }
    </Dialog>
  )
}
