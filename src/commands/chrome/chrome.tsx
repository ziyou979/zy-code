import React, { useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { openBrowser } from '../../utils/browser.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  openInChrome,
} from '../../utils/claudeInChrome/common.js'
import { isChromeExtensionInstalled } from '../../utils/claudeInChrome/setup.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'

const CHROME_EXTENSION_URL = 'https://zy.ai/chrome'
const CHROME_PERMISSIONS_URL = 'https://clau.de/chrome/permissions'
const CHROME_RECONNECT_URL = 'https://clau.de/chrome/reconnect'
type MenuAction = 'install-extension' | 'reconnect' | 'manage-permissions' | 'toggle-default'
type Props = {
  onDone: (result?: string) => void
  isExtensionInstalled: boolean
  configEnabled: boolean | undefined
  isWSL: boolean
}
function ClaudeInChromeMenu({
  onDone,
  isExtensionInstalled: installed,
  configEnabled,
  isWSL,
}: Props) {
  const mcpClients = useAppState((s) => s.mcp.clients)
  const [selectKey, setSelectKey] = useState(0)
  const [enabledByDefault, setEnabledByDefault] = useState(configEnabled ?? false)
  const [showInstallHint, setShowInstallHint] = useState(false)
  const [isExtensionInstalled, setIsExtensionInstalled] = useState(installed)
  const isHomespace = false && isRunningOnHomespace()
  const chromeClient = mcpClients.find((c) => c.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME)
  const isConnected = chromeClient?.type === 'connected'
  const openUrl = function openUrl(url) {
    if (isHomespace) {
      openBrowser(url)
    } else {
      openInChrome(url)
    }
  }
  const handleAction = function handleAction(action) {
    switch (action) {
      case 'install-extension': {
        setSelectKey((k_1) => k_1 + 1)
        setShowInstallHint(true)
        openUrl(CHROME_EXTENSION_URL)
        break
      }
      case 'reconnect': {
        setSelectKey((k_0) => k_0 + 1)
        isChromeExtensionInstalled().then((installed_0) => {
          setIsExtensionInstalled(installed_0)
          if (installed_0) {
            setShowInstallHint(false)
          }
        })
        openUrl(CHROME_RECONNECT_URL)
        break
      }
      case 'manage-permissions': {
        setSelectKey((k) => k + 1)
        openUrl(CHROME_PERMISSIONS_URL)
        break
      }
      case 'toggle-default': {
        const newValue = !enabledByDefault
        saveGlobalConfig((current) => ({
          ...current,
          ClaudeInChromeDefaultEnabled: newValue,
        }))
        setEnabledByDefault(newValue)
      }
    }
  }
  const options = []
  const requiresExtensionSuffix = isExtensionInstalled ? '' : ' (requires extension)'
  if (!isExtensionInstalled && !isHomespace) {
    options.push({
      label: 'Install Chrome extension',
      value: 'install-extension',
    })
  }
  options.push(
    {
      label: (
        <>
          {<Text>Manage permissions</Text>}
          <Text dimColor={true}>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'manage-permissions',
    },
    {
      label: (
        <>
          {<Text>Reconnect extension</Text>}
          <Text dimColor={true}>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'reconnect',
    },
    {
      label: `Enabled by default: ${enabledByDefault ? 'Yes' : 'No'}`,
      value: 'toggle-default',
    },
  )
  const isDisabled = true
  return (
    <Dialog title="Claude in Chrome (Beta)" onCancel={() => onDone()} color="chromeYellow">
      {
        <Box flexDirection="column" gap={1}>
          {
            <Text>
              Claude in Chrome works with the Chrome extension to let you control your browser
              directly from ZY Code. Navigate websites, fill forms, capture screenshots, record
              GIFs, and debug with console logs and network requests.
            </Text>
          }
          {isWSL && (
            <Text color="error">Claude in Chrome is not supported in WSL at this time.</Text>
          )}
          {<Text color="error">Claude in Chrome requires a claude.ai subscription.</Text>}
          {!isDisabled && (
            <>
              {!isHomespace && (
                <Box flexDirection="column">
                  <Text>
                    Status:{' '}
                    {isConnected ? (
                      <Text color="success">Enabled</Text>
                    ) : (
                      <Text color="inactive">Disabled</Text>
                    )}
                  </Text>
                  <Text>
                    Extension:{' '}
                    {isExtensionInstalled ? (
                      <Text color="success">Installed</Text>
                    ) : (
                      <Text color="warning">Not detected</Text>
                    )}
                  </Text>
                </Box>
              )}
              <Select
                key={selectKey}
                options={options}
                onChange={handleAction}
                hideIndexes={true}
              />
              {showInstallHint && (
                <Text color="warning">
                  Once installed, select {'"Reconnect extension"'} to connect.
                </Text>
              )}
              <Text>
                <Text dimColor={true}>Usage: </Text>
                <Text>zy --chrome</Text>
                <Text dimColor={true}> or </Text>
                <Text>zy --no-chrome</Text>
              </Text>
              <Text dimColor={true}>
                Site-level permissions are inherited from the Chrome extension. Manage permissions
                in the Chrome extension settings to control which sites Zy can browse, click, and
                type on.
              </Text>
            </>
          )}
          {<Text dimColor={true}>Learn more: https://code.zy.com/docs/en/chrome</Text>}
        </Box>
      }
    </Dialog>
  )
}
export const call = async (onDone: (result?: string) => void): Promise<React.ReactNode> => {
  const isExtensionInstalled = await isChromeExtensionInstalled()
  const config = getGlobalConfig()
  const isWSL = env.isWslEnvironment()
  return (
    <ClaudeInChromeMenu
      onDone={onDone}
      isExtensionInstalled={isExtensionInstalled}
      configEnabled={config.ClaudeInChromeDefaultEnabled}
      isWSL={isWSL}
    />
  )
}
