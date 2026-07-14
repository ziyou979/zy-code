import partition from 'lodash-es/partition.js'
import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { getInitialSettings, updateSettingsForSource } from '../services/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { SelectMulti } from './CustomSelect/SelectMulti.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js'

type Props = {
  serverNames: string[]
  onDone(): void
}
export function MCPServerMultiselectDialog({ serverNames, onDone }: Props) {
  const onSubmit = function onSubmit(selectedServers: string[]) {
    const currentSettings = getInitialSettings() || {}
    const enabledServers = currentSettings.enabledMcpjsonServers || []
    const disabledServers = currentSettings.disabledMcpjsonServers || []
    const [approvedServers, rejectedServers] = partition(serverNames, (server) =>
      selectedServers.includes(server),
    )
    logEvent('zy_mcp_multidialog_choice', {
      approved: approvedServers.length,
      rejected: rejectedServers.length,
    })
    if (approvedServers.length > 0) {
      const newEnabledServers = [...new Set([...enabledServers, ...approvedServers])]
      updateSettingsForSource('localSettings', {
        enabledMcpjsonServers: newEnabledServers,
      })
    }
    if (rejectedServers.length > 0) {
      const newDisabledServers = [...new Set([...disabledServers, ...rejectedServers])]
      updateSettingsForSource('localSettings', {
        disabledMcpjsonServers: newDisabledServers,
      })
    }
    onDone()
  }
  const handleEscRejectAll = () => {
    const currentSettings_0 = getInitialSettings() || {}
    const disabledServers_0 = currentSettings_0.disabledMcpjsonServers || []
    const newDisabledServers_0 = [...new Set([...disabledServers_0, ...serverNames])]
    updateSettingsForSource('localSettings', {
      disabledMcpjsonServers: newDisabledServers_0,
    })
    onDone()
  }
  const serverOptions = serverNames.map((server_0) => ({
    label: server_0,
    value: server_0,
  }))
  return (
    <>
      {
        <Dialog
          title={`${serverNames.length} new MCP servers found in .mcp.json`}
          subtitle={tSync('mcpServer.select')}
          color="warning"
          onCancel={handleEscRejectAll}
          hideInputGuide={true}
        >
          {<MCPServerDialogCopy />}
          {
            <SelectMulti
              options={serverOptions}
              defaultValue={serverNames}
              onSubmit={onSubmit}
              onCancel={handleEscRejectAll}
              hideIndexes={true}
            />
          }
        </Dialog>
      }
      {
        <Box paddingX={1}>
          <Text dimColor={true} italic={true}>
            <Byline>
              <KeyboardShortcutHint shortcut="Space" action="select" />
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={tSync('mcpServer.rejectAll')}
              />
            </Byline>
          </Text>
        </Box>
      }
    </>
  )
}
