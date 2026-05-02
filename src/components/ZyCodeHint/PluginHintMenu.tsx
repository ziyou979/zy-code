import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../CustomSelect/select.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { tSync } from 'src/i18n/index.js'
type Props = {
  pluginName: string
  pluginDescription?: string
  marketplaceName: string
  sourceCommand: string
  onResponse: (response: 'yes' | 'no' | 'disable') => void
}
const AUTO_DISMISS_MS = 30_000
export function PluginHintMenu({
  pluginName,
  pluginDescription,
  marketplaceName,
  sourceCommand,
  onResponse,
}: Props): React.ReactNode {
  const onResponseRef = React.useRef(onResponse)
  onResponseRef.current = onResponse
  React.useEffect(() => {
    const timeoutId = setTimeout((ref) => ref.current('no'), AUTO_DISMISS_MS, onResponseRef)
    return () => clearTimeout(timeoutId)
  }, [])
  function onSelect(value: string): void {
    switch (value) {
      case 'yes':
        onResponse('yes')
        break
      case 'disable':
        onResponse('disable')
        break
      default:
        onResponse('no')
    }
  }
  const options = [
    {
      label: <Text>{tSync('permission.yesInstallPlugin', { pluginName })}</Text>,
      value: 'yes',
    },
    {
      label: tSync('permission.no'),
      value: 'no',
    },
    {
      label: tSync('permission.noDontShowPluginAgain'),
      value: 'disable',
    },
  ]
  return (
    <PermissionDialog title={tSync('pluginHint.title')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>{tSync('pluginHint.suggestsInstalling', { command: sourceCommand })}</Text>
        </Box>
        <Box>
          <Text dimColor>{tSync('pluginHint.pluginLabel')}</Text>
          <Text> {pluginName}</Text>
        </Box>
        <Box>
          <Text dimColor>{tSync('pluginHint.marketplaceLabel')}</Text>
          <Text> {marketplaceName}</Text>
        </Box>
        {pluginDescription && (
          <Box>
            <Text dimColor>{pluginDescription}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>{tSync('pluginHint.wouldYouInstall')}</Text>
        </Box>
        <Box>
          <Select options={options} onChange={onSelect} onCancel={() => onResponse('no')} />
        </Box>
      </Box>
    </PermissionDialog>
  )
}
