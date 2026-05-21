import { tSync } from 'src/i18n/index.js'
import { Text } from '../ink.js'
import { saveGlobalConfig } from '../utils/config.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  apiKeyTruncated: string
  onDone(approved: boolean): void
}
export function ApproveApiKey({ apiKeyTruncated, onDone }: Props) {
  const onChange = function onChange(value) {
    switch (value) {
      case 'yes': {
        saveGlobalConfig((current_0) => ({
          ...current_0,
          apiKeyResponses: {
            ...current_0.apiKeyResponses,
            approved: [...(current_0.apiKeyResponses?.approved ?? []), apiKeyTruncated],
          },
        }))
        onDone(true)
        break
      }
      case 'no': {
        saveGlobalConfig((current) => ({
          ...current,
          apiKeyResponses: {
            ...current.apiKeyResponses,
            rejected: [...(current.apiKeyResponses?.rejected ?? []), apiKeyTruncated],
          },
        }))
        onDone(false)
      }
    }
  }
  return (
    <Dialog title={tSync('apiKey.detectedTitle')} color="warning" onCancel={() => onChange('no')}>
      {
        <Text>
          {<Text bold={true}>ZY_API_KEY</Text>}
          <Text>: sk-ant-...{apiKeyTruncated}</Text>
        </Text>
      }
      {<Text>{tSync('apiKey.useThisKey')}</Text>}
      {
        <Select
          defaultValue="no"
          defaultFocusValue="no"
          options={[
            {
              label: tSync('permission.yes'),
              value: 'yes',
            },
            {
              label: tSync('permission.noRecommended'),
              value: 'no',
            },
          ]}
          onChange={(value_0) => onChange(value_0 as 'yes' | 'no')}
          onCancel={() => onChange('no')}
        />
      }
    </Dialog>
  )
}
