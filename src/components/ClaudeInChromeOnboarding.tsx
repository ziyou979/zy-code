import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { logEvent } from 'src/services/analytics/index.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to continue
import { Box, Link, Newline, Text, useInput } from '../ink/index.js'
import { isChromeExtensionInstalled } from '../services/claude-in-chrome/setup.js'
import { saveGlobalConfig } from '../services/config/config.js'
import { Dialog } from './design-system/Dialog.js'

const CHROME_EXTENSION_URL = 'https://zy.ai/chrome'
const CHROME_PERMISSIONS_URL = 'https://clau.de/chrome/permissions'
type Props = {
  onDone(): void
}
export function ClaudeInChromeOnboarding({ onDone }: Props) {
  const [isExtensionInstalled, setIsExtensionInstalled] = React.useState(false)
  React.useEffect(() => {
    logEvent('zy_Zy_in_chrome_onboarding_shown', {})
    isChromeExtensionInstalled().then(setIsExtensionInstalled)
    saveGlobalConfig((current) => ({
      ...current,
      hasCompletedClaudeInChromeOnboarding: true,
    }))
  }, [])
  useInput((_input, key) => {
    if (key.return) {
      onDone()
    }
  })
  return (
    <Dialog title={tSync('claudeChrome.title')} onCancel={onDone} color="chromeYellow">
      {
        <Box flexDirection="column" gap={1}>
          {
            <Text>
              {tSync('claudeChrome.description')}
              {!isExtensionInstalled && (
                <>
                  <Newline />
                  <Newline />
                  {tSync('claudeChrome.requiresExtension')} <Link url={CHROME_EXTENSION_URL} />
                </>
              )}
            </Text>
          }
          {
            <Text dimColor={true}>
              {tSync('claudeChrome.permissionsNote')}
              {isExtensionInstalled && (
                <>
                  {' '}
                  (<Link url={CHROME_PERMISSIONS_URL} />)
                </>
              )}
              .
            </Text>
          }
          {
            <Text dimColor={true}>
              {tSync('claudeChrome.forMoreInfo')}{' '}
              {
                <Text bold={true} color="chromeYellow">
                  /chrome
                </Text>
              }{' '}
              {tSync('claudeChrome.orVisit')} <Link url="https://code.zy.com/docs/en/chrome" />
            </Text>
          }
        </Box>
      }
    </Dialog>
  )
}
