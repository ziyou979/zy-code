import React from 'react'
import type { ChannelEntry } from '../bootstrap/state.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
type Props = {
  channels: ChannelEntry[]
  onAccept(): void
}
export function DevChannelsDialog({ channels, onAccept }: Props) {
  const onChange = function onChange(value) {
    switch (value) {
      case 'accept': {
        onAccept()
        break
      }
      case 'exit': {
        gracefulShutdownSync(1)
      }
    }
  }
  const handleEscape = () => {
    gracefulShutdownSync(0)
  }
  const channelsDisplayText = channels
    .map((c) => (c.kind === 'plugin' ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`))
    .join(', ')
  return (
    <Dialog title={tSync('devChannels.warning')} color="error" onCancel={handleEscape}>
      {
        <Box flexDirection="column" gap={1}>
          {<Text>{tSync('devChannels.description')}</Text>}
          {<Text>{tSync('devChannels.useChannels')}</Text>}
          <Text dimColor={true}>Channels: {channelsDisplayText}</Text>
        </Box>
      }
      {
        <Select
          options={[
            {
              label: tSync('devChannels.confirmDev'),
              value: 'accept',
            },
            {
              label: tSync('devChannels.exit'),
              value: 'exit',
            },
          ]}
          onChange={(value_0) => onChange(value_0 as 'accept' | 'exit')}
        />
      }
    </Dialog>
  )
}
