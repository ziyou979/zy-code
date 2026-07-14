import { basename } from 'node:path'
import { useEffect, useState } from 'react'
import { getOriginalCwd } from '../bootstrap/runtime/runtimeContext.js'
import {
  buildActiveFooterText,
  buildIdleFooterText,
  FAILED_FOOTER_TEXT,
  getWireStatus,
} from '../bridge/bridgeStatusUtil.js'
import { BRIDGE_FAILED_INDICATOR, BRIDGE_READY_INDICATOR } from '../constants/figures.js'
import { useRegisterOverlay } from '../context/OverlayContext.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw 'd' key for disconnect, not a configurable keybinding action
import { Box, Text, useInput } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { saveGlobalConfig } from '../services/config/config.js'
import { getBranch } from '../utils/git.js'
import { Dialog } from './design-system/Dialog.js'
import { QRCodeDisplay } from './QRCodeDisplay.js'

type Props = {
  onDone: () => void
}
export function BridgeDialog({ onDone }: Props) {
  useRegisterOverlay('bridge-dialog')
  const connected = useAppState((state) => state.replWireConnected)
  const sessionActive = useAppState((state) => state.replWireSessionActive)
  const reconnecting = useAppState((state) => state.replWireReconnecting)
  const connectUrl = useAppState((state) => state.replWireConnectUrl)
  const sessionUrl = useAppState((state) => state.replWireSessionUrl)
  const error = useAppState((state) => state.replWireError)
  const explicit = useAppState((state) => state.replWireExplicit)
  const environmentId = useAppState((state) => state.replWireEnvironmentId)
  const sessionId = useAppState((state) => state.replWireSessionId)
  const verbose = useAppState((state) => state.verbose)
  const setAppState = useSetAppState()
  const [showQR, setShowQR] = useState(false)
  const [branchName, setBranchName] = useState('')
  const repoName = basename(getOriginalCwd())
  useEffect(() => {
    getBranch().then(setBranchName).catch(_temp1)
  }, [])
  const displayUrl = sessionActive ? sessionUrl : connectUrl
  useKeybindings(
    {
      'confirm:yes': onDone,
      'confirm:toggle': () => {
        setShowQR((prev) => !prev)
      },
    },
    {
      context: 'Confirmation',
    },
  )
  useInput((input) => {
    if (input === 'd') {
      if (explicit) {
        saveGlobalConfig((current) => {
          if (current.remoteControlAtStartup === false) {
            return current
          }
          return {
            ...current,
            remoteControlAtStartup: false,
          }
        })
      }
      setAppState((prev) => {
        if (!prev.replBridgeEnabled) {
          return prev
        }
        return {
          ...prev,
          replBridgeEnabled: false,
        }
      })
      onDone()
    }
  })
  const { label: statusLabel, color: statusColor } = getWireStatus({
    error,
    connected,
    sessionActive,
    reconnecting,
  })
  const indicator = error ? BRIDGE_FAILED_INDICATOR : BRIDGE_READY_INDICATOR
  let BoxComponent
  let DialogComponent
  let footerText

  let qrBoxElement

  const contextParts = []
  if (repoName) {
    contextParts.push(repoName)
  }
  if (branchName) {
    contextParts.push(branchName)
  }
  const contextSuffix = contextParts.length > 0 ? ` \xB7 ${contextParts.join(' \xB7 ')}` : ''
  footerText = error
    ? FAILED_FOOTER_TEXT
    : displayUrl
      ? sessionActive
        ? buildActiveFooterText(displayUrl)
        : buildIdleFooterText(displayUrl)
      : undefined
  DialogComponent = Dialog

  const handleCancel = onDone

  BoxComponent = Box

  const statusBoxElement = (
    <Box flexDirection="column">
      {
        <Text>
          {
            <Text color={statusColor}>
              {indicator} {statusLabel}
            </Text>
          }
          {<Text dimColor={true}>{contextSuffix}</Text>}
        </Text>
      }
      {error && <Text color="error">{error}</Text>}
      {verbose && environmentId && <Text dimColor={true}>Environment: {environmentId}</Text>}
      {verbose && sessionId && <Text dimColor={true}>Session: {sessionId}</Text>}
    </Box>
  )
  qrBoxElement = <QRCodeDisplay displayUrl={displayUrl} showQR={showQR} />
  return (
    <DialogComponent title={'Remote Control'} onCancel={handleCancel} hideInputGuide={true}>
      {
        <BoxComponent flexDirection={'column'} gap={1}>
          {statusBoxElement}
          {qrBoxElement}
          {footerText && <Text dimColor={true}>{footerText}</Text>}
          {<Text dimColor={true}>d to disconnect · space for QR code · Enter/Esc to close</Text>}
        </BoxComponent>
      }
    </DialogComponent>
  )
}
function _temp1() {}
