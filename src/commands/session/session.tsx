import { toString as qrToString } from 'qrcode'
import { useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../types.js'
import { logForDebugging } from '../../utils/debug.js'

type Props = {
  onDone: () => void
}
function SessionInfo({ onDone }: Props) {
  const remoteSessionUrl = useAppState((s) => s.remoteSessionUrl)
  const [qrCode, setQrCode] = useState('')
  useEffect(() => {
    if (!remoteSessionUrl) {
      return
    }
    const url = remoteSessionUrl
    const generateQRCode = async function generateQRCode() {
      const qr = await qrToString(url, {
        type: 'utf8',
        errorCorrectionLevel: 'L',
      })
      setQrCode(qr)
    }
    generateQRCode().catch((e) => {
      logForDebugging('QR code generation failed', e)
    })
  }, [remoteSessionUrl])
  useKeybinding('confirm:no', onDone, {
    context: 'Confirmation',
  })
  if (!remoteSessionUrl) {
    return (
      <Pane>
        <Text color="warning">
          Not in remote mode. Start with `zycode --remote` to use this command.
        </Text>
        <Text dimColor={true}>(press esc to close)</Text>
      </Pane>
    )
  }
  const lines = qrCode.split('\n').filter((line) => line.length > 0)
  const isLoading = lines.length === 0
  const ContainerPane = Pane
  const qrContent = isLoading ? (
    <Text dimColor={true}>Generating QR code…</Text>
  ) : (
    lines.map((line, i) => <Text key={i}>{line}</Text>)
  )
  return (
    <ContainerPane>
      {
        <Box marginBottom={1}>
          <Text bold={true}>Remote session</Text>
        </Box>
      }
      {qrContent}
      {
        <Box marginTop={1}>
          {<Text dimColor={true}>Open in browser: </Text>}
          <Text color="ide">{remoteSessionUrl}</Text>
        </Box>
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>(press esc to close)</Text>
        </Box>
      }
    </ContainerPane>
  )
}
export const call: LocalJSXCommandCall = async (onDone) => {
  return <SessionInfo onDone={onDone} />
}
