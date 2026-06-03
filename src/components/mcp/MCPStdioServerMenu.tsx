import figures from 'figures'
import React, { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, color, Text, useTheme } from '../../ink.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import { useMcpReconnect, useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js'
import { describeMcpConfigFilePath, filterMcpPromptsByServer } from '../../services/mcp/utils.js'
import { useAppState } from '../../state/AppState.js'
import { errorMessage } from '../../utils/errors.js'
import { capitalize } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Select } from '../CustomSelect/index.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Spinner } from '../Spinner.js'
import { CapabilitiesSection } from './CapabilitiesSection.js'
import type { StdioServerInfo } from './types.js'
import { handleReconnectError, handleReconnectResult } from './utils/reconnectHelpers.js'

type Props = {
  server: StdioServerInfo
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  borderless?: boolean
}
export function MCPStdioServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: Props): React.ReactNode {
  const [theme] = useTheme()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const mcp = useAppState((s) => s.mcp)
  const reconnectMcpServer = useMcpReconnect()
  const toggleMcpServer = useMcpToggleEnabled()
  const [isReconnecting, setIsReconnecting] = useState(false)
  const handleToggleEnabled = React.useCallback(async () => {
    const wasEnabled = (server as any).client.type !== 'disabled'
    try {
      await toggleMcpServer(server.name)
      // Return to the server list so user can continue managing other servers
      onCancel()
    } catch (err) {
      const _action = wasEnabled ? 'disable' : 'enable'
      onComplete(
        tSync('mcp.failedToToggle', {
          action: wasEnabled ? tSync('mcp.disable') : tSync('mcp.enable'),
          serverName: server.name,
          error: errorMessage(err),
        }),
      )
    }
  }, [(server as any).client.type, server.name, toggleMcpServer, onCancel, onComplete])
  const capitalizedServerName = capitalize(String(server.name))

  // Count MCP prompts for this server (skills are shown in /skills, not here)
  const serverCommandsCount = filterMcpPromptsByServer(mcp.commands, server.name).length
  const menuOptions = []

  // Only show "View tools" if server is not disabled and has tools
  if ((server as any).client.type !== 'disabled' && serverToolsCount > 0) {
    menuOptions.push({
      label: tSync('mcp.viewTools'),
      value: 'tools',
    })
  }

  // Only show reconnect option if the server is not disabled
  if ((server as any).client.type !== 'disabled') {
    menuOptions.push({
      label: tSync('mcp.reconnect'),
      value: 'reconnectMcpServer',
    })
  }
  menuOptions.push({
    label: (server as any).client.type !== 'disabled' ? tSync('mcp.disable') : tSync('mcp.enable'),
    value: 'toggle-enabled',
  })

  // If there are no other options, add a back option so Select handles escape
  if (menuOptions.length === 0) {
    menuOptions.push({
      label: tSync('mcp.back'),
      value: 'back',
    })
  }
  if (isReconnecting) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="text">{tSync('mcp.reconnectingTo', { serverName: server.name })}</Text>
        <Box>
          <Spinner />
          <Text> {tSync('mcp.restartingMCPProcess')}</Text>
        </Box>
        <Text dimColor>{tSync('mcp.mayTakeAMoment')}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1} borderStyle={borderless ? undefined : 'round'}>
        <Box marginBottom={1}>
          <Text bold>{tSync('mcp.serverTitle', { serverName: capitalizedServerName })}</Text>
        </Box>

        <Box flexDirection="column" gap={0}>
          <Box>
            <Text bold>{tSync('mcp.statusLabel')} </Text>
            {(server as any).client.type === 'disabled' ? (
              <Text>
                {color('inactive', theme)(figures.radioOff)} {tSync('mcp.disabled')}
              </Text>
            ) : (server as any).client.type === 'connected' ? (
              <Text>
                {color('success', theme)(figures.tick)} {tSync('mcp.connected')}
              </Text>
            ) : (server as any).client.type === 'pending' ? (
              <>
                <Text dimColor>{figures.radioOff}</Text>
                <Text> {tSync('mcp.connecting')}</Text>
              </>
            ) : (
              <Text>
                {color('error', theme)(figures.cross)} {tSync('mcp.failed')}
              </Text>
            )}
          </Box>

          <Box>
            <Text bold>{tSync('mcp.commandLabel')} </Text>
            <Text dimColor>{(server as any).config.command}</Text>
          </Box>

          {(server as any).config.args && (server as any).config.args.length > 0 && (
            <Box>
              <Text bold>{tSync('mcp.argsLabel')} </Text>
              <Text dimColor>{(server as any).config.args.join(' ')}</Text>
            </Box>
          )}

          <Box>
            <Text bold>{tSync('mcp.configLocationLabel')} </Text>
            <Text dimColor>
              {describeMcpConfigFilePath(getMcpConfigByName(server.name)?.scope ?? 'dynamic')}
            </Text>
          </Box>

          {(server as any).client.type === 'connected' && (
            <CapabilitiesSection
              serverToolsCount={serverToolsCount}
              serverPromptsCount={serverCommandsCount}
              serverResourcesCount={mcp.resources[server.name]?.length || 0}
            />
          )}

          {(server as any).client.type === 'connected' && serverToolsCount > 0 && (
            <Box>
              <Text bold>{tSync('mcp.toolsLabel')} </Text>
              <Text dimColor>{tSync('mcp.toolsCount', { count: serverToolsCount })}</Text>
            </Box>
          )}
        </Box>

        {menuOptions.length > 0 && (
          <Box marginTop={1}>
            <Select
              options={menuOptions}
              onChange={async (value: string) => {
                if (value === 'tools') {
                  onViewTools()
                } else if (value === 'reconnectMcpServer') {
                  setIsReconnecting(true)
                  try {
                    const result = await reconnectMcpServer(server.name)
                    const { message } = handleReconnectResult(result, server.name)
                    onComplete?.(message)
                  } catch (err_0) {
                    onComplete?.(handleReconnectError(err_0, server.name))
                  } finally {
                    setIsReconnecting(false)
                  }
                } else if (value === 'toggle-enabled') {
                  await handleToggleEnabled()
                } else if (value === 'back') {
                  onCancel()
                }
              }}
              onCancel={onCancel}
            />
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor italic>
          {exitState.pending ? (
            tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName ?? '' })
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
              <KeyboardShortcutHint shortcut="Enter" action="select" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={tSync('mcp.back')}
              />
            </Byline>
          )}
        </Text>
      </Box>
    </Box>
  )
}
