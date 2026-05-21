import { tSync } from 'src/i18n/index.js'
import { Text } from '../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { isSupportedTerminal } from '../utils/ide.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type IdeAutoConnectDialogProps = {
  onComplete: () => void
}
export function IdeAutoConnectDialog({ onComplete }: IdeAutoConnectDialogProps) {
  const handleSelect = async (value) => {
    const autoConnect = value === 'yes'
    saveGlobalConfig((current) => ({
      ...current,
      autoConnectIde: autoConnect,
      hasIdeAutoConnectDialogBeenShown: true,
    }))
    onComplete()
  }
  const options = [
    {
      label: tSync('permission.yes'),
      value: 'yes',
    },
    {
      label: tSync('permission.no'),
      value: 'no',
    },
  ]
  return (
    <Dialog title={tSync('ide.autoConnectTitle')} color="ide" onCancel={onComplete}>
      {<Select options={options} onChange={handleSelect} defaultValue="yes" />}
      {<Text dimColor={true}>{tSync('ide.autoConnectHint')}</Text>}
    </Dialog>
  )
}
export function shouldShowAutoConnectDialog(): boolean {
  const config = getGlobalConfig()
  return (
    !isSupportedTerminal() &&
    config.autoConnectIde !== true &&
    config.hasIdeAutoConnectDialogBeenShown !== true
  )
}
type IdeDisableAutoConnectDialogProps = {
  onComplete: (disableAutoConnect: boolean) => void
}
export function IdeDisableAutoConnectDialog({ onComplete }: IdeDisableAutoConnectDialogProps) {
  const handleSelect = (value) => {
    const disableAutoConnect = value === 'yes'
    if (disableAutoConnect) {
      saveGlobalConfig((current) => ({
        ...current,
        autoConnectIde: false,
      }))
    }
    onComplete(disableAutoConnect)
  }
  const handleCancel = () => {
    onComplete(false)
  }
  const options = [
    {
      label: tSync('permission.no'),
      value: 'no',
    },
    {
      label: tSync('permission.yes'),
      value: 'yes',
    },
  ]
  return (
    <Dialog
      title={tSync('ide.disableAutoConnectTitle')}
      subtitle={tSync('ide.disableAutoConnectHint')}
      onCancel={handleCancel}
      color="ide"
    >
      {<Select options={options} onChange={handleSelect} defaultValue="no" />}
    </Dialog>
  )
}
export function shouldShowDisableAutoConnectDialog(): boolean {
  const config = getGlobalConfig()
  return !isSupportedTerminal() && config.autoConnectIde === true
}
