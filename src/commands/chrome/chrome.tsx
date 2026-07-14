import React, { useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  openInChrome,
} from '../../services/claude-in-chrome/common.js'
import { isChromeExtensionInstalled } from '../../services/claude-in-chrome/setup.js'
import { useAppState } from '../../state/AppState.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
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
  const openUrl = function openUrl(url: string) {
    if (isHomespace) {
      openBrowser(url)
    } else {
      openInChrome(url)
    }
  }
  const handleAction = function handleAction(action: MenuAction) {
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
  const requiresExtensionSuffix = isExtensionInstalled ? '' : tSync('chromeCmd.requiresExtension')
  if (!isExtensionInstalled && !isHomespace) {
    options.push({
      label: tSync('chromeCmd.installExtension'),
      value: 'install-extension',
    })
  }
  options.push(
    {
      label: (
        <>
          {<Text>{tSync('chromeCmd.managePermissions')}</Text>}
          <Text dimColor={true}>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'manage-permissions',
    },
    {
      label: (
        <>
          {<Text>{tSync('chromeCmd.reconnectExtension')}</Text>}
          <Text dimColor={true}>{requiresExtensionSuffix}</Text>
        </>
      ),
      value: 'reconnect',
    },
    {
      label: `${tSync('chromeCmd.enabledByDefault', { value: enabledByDefault ? tSync('chromeCmd.yes') : tSync('chromeCmd.no') })}`,
      value: 'toggle-default',
    },
  )
  const isDisabled = true
  return (
    <Dialog title={tSync('chromeCmd.title')} onCancel={() => onDone()} color="chromeYellow">
      {
        <Box flexDirection="column" gap={1}>
          {<Text>{tSync('chromeCmd.description')}</Text>}
          {isWSL && <Text color="error">{tSync('chromeCmd.notSupportedOnWSL')}</Text>}
          {<Text color="error">{tSync('chromeCmd.requiresSubscription')}</Text>}
          {!isDisabled && (
            <>
              {!isHomespace && (
                <Box flexDirection="column">
                  <Text>
                    {tSync('chromeCmd.status')}
                    {isConnected ? (
                      <Text color="success">{tSync('chromeCmd.statusEnabled')}</Text>
                    ) : (
                      <Text color="inactive">{tSync('chromeCmd.statusDisabled')}</Text>
                    )}
                  </Text>
                  <Text>
                    {tSync('chromeCmd.extension')}
                    {isExtensionInstalled ? (
                      <Text color="success">{tSync('chromeCmd.extensionInstalled')}</Text>
                    ) : (
                      <Text color="warning">{tSync('chromeCmd.extensionNotDetected')}</Text>
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
              {showInstallHint && <Text color="warning">{tSync('chromeCmd.installHint')}</Text>}
              <Text>
                <Text dimColor={true}>{tSync('chromeCmd.usageLabel')}</Text>
                <Text>zycode --chrome</Text>
                <Text dimColor={true}>{tSync('chromeCmd.or')}</Text>
                <Text>zycode --no-chrome</Text>
              </Text>
              <Text dimColor={true}>{tSync('chromeCmd.sitePermissions')}</Text>
            </>
          )}
          {
            <Text dimColor={true}>
              {tSync('chromeCmd.learnMore')}https://code.zy.com/docs/en/chrome
            </Text>
          }
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
