import React, { useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
type Props = {
  onProceed: (signal: AbortSignal) => Promise<void>
  onCancel: () => void
}
export function UltrareviewOverageDialog({ onProceed, onCancel }: Props) {
  const [isLaunching, setIsLaunching] = useState(false)
  const initialAbortController = new AbortController()
  const abortControllerRef = useRef(initialAbortController)
  const handleSelect = (value) => {
    if (value === 'proceed') {
      setIsLaunching(true)
      onProceed(abortControllerRef.current.signal).catch(() => setIsLaunching(false))
    } else {
      onCancel()
    }
  }
  const handleCancel = () => {
    abortControllerRef.current.abort()
    onCancel()
  }
  const options = [
    {
      label: 'Proceed with Extra Usage billing',
      value: 'proceed',
    },
    {
      label: 'Cancel',
      value: 'cancel',
    },
  ]
  return (
    <Dialog title="Ultrareview billing" onCancel={handleCancel} color="background">
      {
        <Box flexDirection="column" gap={1}>
          {
            <Text>
              Your free ultrareviews for this organization are used. Further reviews bill as Extra
              Usage (pay-per-use).
            </Text>
          }
          {isLaunching ? (
            <Text color="background">Launching…</Text>
          ) : (
            <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
          )}
        </Box>
      }
    </Dialog>
  )
}
