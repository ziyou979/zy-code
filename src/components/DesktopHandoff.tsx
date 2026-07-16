import { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../commands/index.js'
import { tSync } from '../i18n/index.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw input for "any key" dismiss and y/n prompt
import { Box, Text, useInput } from '../ink/index.js'
import { openBrowser } from '../utils/browser.js'
import { getDesktopInstallStatus, openCurrentSessionInDesktop } from '../utils/desktopDeepLink.js'
import { errorMessage } from '../utils/errors.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { flushSessionStorage } from '../services/sessionStorage.js'
import { LoadingState } from './design-system/LoadingState.js'

const DESKTOP_DOCS_URL = 'https://clau.de/desktop'
export function getDownloadUrl(): string {
  switch (process.platform) {
    case 'win32':
      return 'https://zy.ai/api/desktop/win32/x64/exe/latest/redirect'
    default:
      return 'https://zy.ai/api/desktop/darwin/universal/dmg/latest/redirect'
  }
}
type DesktopHandoffState =
  | 'checking'
  | 'prompt-download'
  | 'flushing'
  | 'opening'
  | 'success'
  | 'error'
type Props = {
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
export function DesktopHandoff({ onDone }: Props) {
  const [state, setState] = useState<
    'checking' | 'flushing' | 'opening' | 'success' | 'error' | 'prompt-download'
  >('checking')
  const [error, setError] = useState<string | null>(null)
  const [downloadMessage, setDownloadMessage] = useState('')
  useInput((input) => {
    if (state === 'error') {
      onDone(error ?? tSync('desktopHandoff.unknownError'), {
        display: 'system',
      })
      return
    }
    if (state === 'prompt-download') {
      if (input === 'y' || input === 'Y') {
        openBrowser(getDownloadUrl()).catch(_temp)
        onDone(tSync('desktopHandoff.startingDownload', { url: DESKTOP_DOCS_URL }), {
          display: 'system',
        })
      } else {
        if (input === 'n' || input === 'N') {
          onDone(tSync('desktopHandoff.desktopRequired', { url: DESKTOP_DOCS_URL }), {
            display: 'system',
          })
        }
      }
    }
  })
  useEffect(() => {
    const performHandoff = async function performHandoff() {
      setState('checking')
      const installStatus = await getDesktopInstallStatus()
      if (installStatus.status === 'not-installed') {
        setDownloadMessage(tSync('desktopHandoff.notInstalled'))
        setState('prompt-download')
        return
      }
      if (installStatus.status === 'version-too-old') {
        setDownloadMessage(tSync('desktopHandoff.needsUpdate', { version: installStatus.version }))
        setState('prompt-download')
        return
      }
      setState('flushing')
      await flushSessionStorage()
      setState('opening')
      const result = await openCurrentSessionInDesktop()
      if (!result.success) {
        setError(result.error ?? tSync('desktopHandoff.openFailed'))
        setState('error')
        return
      }
      setState('success')
      setTimeout(
        async (onDone_0) => {
          onDone_0(tSync('desktopHandoff.sessionTransferred'), {
            display: 'system',
          })
          await gracefulShutdown(0, 'other')
        },
        500,
        onDone,
      )
    }
    performHandoff().catch((err) => {
      setError(errorMessage(err))
      setState('error')
    })
  }, [onDone])
  if (state === 'error') {
    return (
      <Box flexDirection="column" paddingX={2}>
        {<Text color="error">{tSync('desktopHandoff.errorLabel', { error: error ?? '' })}</Text>}
        {<Text dimColor={true}>{tSync('desktopHandoff.pressAnyKey')}</Text>}
      </Box>
    )
  }
  if (state === 'prompt-download') {
    return (
      <Box flexDirection="column" paddingX={2}>
        {<Text>{downloadMessage}</Text>}
        {<Text>{tSync('desktopHandoff.downloadNow')}</Text>}
      </Box>
    )
  }
  const messages = {
    checking: tSync('desktopHandoff.checking'),
    flushing: tSync('desktopHandoff.savingSession'),
    opening: tSync('desktopHandoff.opening'),
    success: tSync('desktopHandoff.openingInDesktop'),
  }
  return <LoadingState message={messages[state]} />
}
function _temp() {}
