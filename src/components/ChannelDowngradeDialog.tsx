import React from 'react'
import { Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { tSync } from 'src/i18n/index.js'
export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel'
type Props = {
  currentVersion: string
  onChoice: (choice: ChannelDowngradeChoice) => void
}

/**
 * Dialog shown when switching from latest to stable channel.
 * Allows user to choose whether to downgrade or stay on current version.
 */
export function ChannelDowngradeDialog({ currentVersion, onChoice }: Props) {
  const handleSelect = function handleSelect(value) {
    onChoice(value)
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
