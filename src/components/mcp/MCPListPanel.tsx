import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { CROSS, POINTER, RADIO_OFF, TICK, TRIANGLE_UP_OUTLINE } from '../../constants/figures.js'
import { Box, color, Link, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { ConfigScope } from '../../services/mcp/types.js'
import { describeMcpConfigFilePath } from '../../services/mcp/utils.js'
import { isDebugMode } from '../../utils/debug.js'
import { plural } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { McpParsingWarnings } from './McpParsingWarnings.js'
import type { AgentMcpServerInfo, ServerInfo } from './types.js'

type Props = {
  servers: ServerInfo[]
  agentServers?: AgentMcpServerInfo[]
  onSelectServer: (server: ServerInfo) => void
  onSelectAgentServer?: (agentServer: AgentMcpServerInfo) => void
  onComplete: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  defaultTab?: string
}
type SelectableItem =
  | {
      type: 'server'
      server: ServerInfo
    }
  | {
      type: 'agent-server'
      agentServer: AgentMcpServerInfo
    }

// Define scope order for display (constant, outside component)
// 'dynamic' (built-in) is rendered separately at the end
const SCOPE_ORDER: ConfigScope[] = ['project', 'local', 'user', 'enterprise']

// Get scope heading parts (label is bold, path is grey)
function getScopeHeading(scope: ConfigScope): {
  label: string
  path?: string
} {
  switch (scope) {
    case 'project':
      return {
        label: tSync('mcp.projectMCPs'),
        path: describeMcpConfigFilePath(scope),
      }
    case 'user':
      return {
        label: tSync('mcp.userMCPs'),
        path: describeMcpConfigFilePath(scope),
      }
    case 'local':
      return {
        label: tSync('mcp.localMCPs'),
        path: describeMcpConfigFilePath(scope),
      }
    case 'enterprise':
      return {
        label: tSync('mcp.enterpriseMCPs'),
      }
    case 'dynamic':
      return {
        label: tSync('mcp.builtInMCPs'),
        path: tSync('mcp.alwaysAvailable'),
      }
    default:
      return {
        label: scope,
      }
  }
}

// Group servers by scope
function groupServersByScope(serverList: ServerInfo[]): Map<ConfigScope, ServerInfo[]> {
  const groups = new Map<ConfigScope, ServerInfo[]>()
  for (const server of serverList) {
    const scope = server.scope
    if (!groups.has(scope)) {
      groups.set(scope, [])
    }
    groups.get(scope)!.push(server)
  }
  // Sort servers within each group alphabetically
  for (const [, groupServers] of groups) {
    groupServers.sort((a, b) => a.name.localeCompare(b.name))
  }
  return groups
}
export function MCPListPanel({
  servers,
  agentServers: agentServersArg = [],
  onSelectServer,
  onSelectAgentServer,
  onComplete,
}: Props) {
  const agentServers = agentServersArg
  const [theme] = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const regularServers = servers.filter((s) => s.client.config.type !== 'zyai-proxy')
  const serversByScope = groupServersByScope(regularServers)
  const zyAiServers = servers
    .filter((s) => s.client.config.type === 'zyai-proxy')
    .sort((a, b) => a.name.localeCompare(b.name))
  const dynamicServers = (serversByScope.get('dynamic') ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const dynamicHeading = getScopeHeading('dynamic')
  const items: SelectableItem[] = []
  for (const scope of SCOPE_ORDER) {
    const scopeServers = serversByScope.get(scope) ?? []
    for (const server of scopeServers) {
      items.push({
        type: 'server',
        server,
      })
    }
  }
  for (const zyAiServer of zyAiServers) {
    items.push({
      type: 'server',
      server: zyAiServer,
    })
  }
  for (const agentServer of agentServers) {
    items.push({
      type: 'agent-server',
      agentServer,
    })
  }
  for (const dynamicServer of dynamicServers) {
    items.push({
      type: 'server',
      server: dynamicServer,
    })
  }
  const selectableItems = items
  const handleCancel = () => {
    onComplete(tSync('mcp.dialogDismissed'), {
      display: 'system',
    })
  }
  const handleSelect = () => {
    const item = selectableItems[selectedIndex]
    if (!item) {
      return
    }
    if (item.type === 'server') {
      onSelectServer(item.server)
    } else {
      if (item.type === 'agent-server' && onSelectAgentServer) {
        onSelectAgentServer(item.agentServer)
      }
    }
  }
  useKeybindings(
    {
      'confirm:previous': () =>
        setSelectedIndex((prev) => (prev === 0 ? selectableItems.length - 1 : prev - 1)),
      'confirm:next': () =>
        setSelectedIndex((prev) => (prev === selectableItems.length - 1 ? 0 : prev + 1)),
      'confirm:yes': handleSelect,
      'confirm:no': handleCancel,
    },
    {
      context: 'Confirmation',
    },
  )
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  const getServerIndex = (targetServer: any) =>
    selectableItems.findIndex((item) => item.type === 'server' && item.server === targetServer)
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  const getAgentServerIndex = (targetAgentServer: any) =>
    selectableItems.findIndex(
      (item) => item.type === 'agent-server' && item.agentServer === targetAgentServer,
    )
  const debugMode = isDebugMode()
  const hasFailedClients = servers.some((s) => s.client.type === 'failed')
  if (servers.length === 0 && agentServers.length === 0) {
    return null
  }
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  const renderServerItem = (server: any) => {
    const index = getServerIndex(server)
    const isSelected = selectedIndex === index
    let statusIcon
    let statusText
    if (server.client.type === 'disabled') {
      statusIcon = color('inactive', theme)(RADIO_OFF)
      statusText = tSync('mcp.disabled')
    } else {
      if (server.client.type === 'connected') {
        statusIcon = color('success', theme)(TICK)
        statusText = tSync('mcp.connected')
      } else {
        if (server.client.type === 'pending') {
          statusIcon = color('inactive', theme)(RADIO_OFF)
          const { reconnectAttempt, maxReconnectAttempts } = server.client
          if (reconnectAttempt && maxReconnectAttempts) {
            statusText = tSync('mcp.reconnectingWithProgress', {
              current: reconnectAttempt,
              max: maxReconnectAttempts,
            })
          } else {
            statusText = tSync('mcp.connecting')
          }
        } else {
          if (server.client.type === 'needs-auth') {
            statusIcon = color('warning', theme)(TRIANGLE_UP_OUTLINE)
            statusText = tSync('mcp.needsAuthentication')
          } else {
            statusIcon = color('error', theme)(CROSS)
            statusText = tSync('mcp.failed')
          }
        }
      }
    }
    return (
      <Box key={`${server.name}-${index}`}>
        <Text color={isSelected ? 'suggestion' : undefined}>
          {isSelected ? `${POINTER} ` : '  '}
        </Text>
        <Text color={isSelected ? 'suggestion' : undefined}>{server.name}</Text>
        <Text dimColor={!isSelected}> · {statusIcon} </Text>
        <Text dimColor={!isSelected}>{statusText}</Text>
      </Box>
    )
  }
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  const renderAgentServerItem = (agentServer: any) => {
    const index = getAgentServerIndex(agentServer)
    const isSelected = selectedIndex === index
    const statusIcon = agentServer.needsAuth
      ? color('warning', theme)(TRIANGLE_UP_OUTLINE)
      : color('inactive', theme)(RADIO_OFF)
    const statusText = agentServer.needsAuth ? tSync('mcp.mayNeedAuth') : tSync('mcp.agentOnly')
    return (
      <Box key={`agent-${agentServer.name}-${index}`}>
        <Text color={isSelected ? 'suggestion' : undefined}>
          {isSelected ? `${POINTER} ` : '  '}
        </Text>
        <Text color={isSelected ? 'suggestion' : undefined}>{agentServer.name}</Text>
        <Text dimColor={!isSelected}> · {statusIcon} </Text>
        <Text dimColor={!isSelected}>{statusText}</Text>
      </Box>
    )
  }
  const totalServers = servers.length + agentServers.length
  const serverCountLabel = plural(totalServers, 'server')
  const scopeSections = SCOPE_ORDER.map((scope) => {
    const scopeServers = serversByScope.get(scope)
    if (!scopeServers || scopeServers.length === 0) {
      return null
    }
    const heading = getScopeHeading(scope)
    return (
      <Box key={scope} flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold={true}>{heading.label}</Text>
          {heading.path && <Text dimColor={true}> ({heading.path})</Text>}
        </Box>
        {scopeServers.map((server) => renderServerItem(server))}
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      {<McpParsingWarnings />}
      {
        <Dialog
          title={tSync('mcp.manageServers')}
          subtitle={`${totalServers} ${serverCountLabel}`}
          onCancel={handleCancel}
          hideInputGuide={true}
        >
          {
            <Box flexDirection="column">
              {scopeSections}
              {zyAiServers.length > 0 && (
                <Box flexDirection="column" marginBottom={1}>
                  <Box paddingLeft={2}>
                    <Text bold={true}>zy.ai</Text>
                  </Box>
                  {zyAiServers.map((server) => renderServerItem(server))}
                </Box>
              )}
              {agentServers.length > 0 && (
                <Box flexDirection="column" marginBottom={1}>
                  <Box paddingLeft={2}>
                    <Text bold={true}>{tSync('mcp.agentMCPs')}</Text>
                  </Box>
                  {[...new Set(agentServers.flatMap((s) => s.sourceAgents))].map((agentName) => (
                    <Box key={agentName} flexDirection="column" marginTop={1}>
                      <Box paddingLeft={2}>
                        <Text dimColor={true}>@{agentName}</Text>
                      </Box>
                      {agentServers
                        .filter((s) => s.sourceAgents.includes(agentName))
                        .map((agentServer) => renderAgentServerItem(agentServer))}
                    </Box>
                  ))}
                </Box>
              )}
              {dynamicServers.length > 0 && (
                <Box flexDirection="column" marginBottom={1}>
                  <Box paddingLeft={2}>
                    <Text bold={true}>{dynamicHeading.label}</Text>
                    {dynamicHeading.path && <Text dimColor={true}> ({dynamicHeading.path})</Text>}
                  </Box>
                  {dynamicServers.map((server) => renderServerItem(server))}
                </Box>
              )}
              {
                <Box flexDirection="column">
                  {hasFailedClients && (
                    <Text dimColor={true}>
                      {debugMode ? tSync('mcp.errorLogsInline') : tSync('mcp.runDebugForLogs')}
                    </Text>
                  )}
                  {
                    <Text dimColor={true}>
                      <Link url="https://code.zy.com/docs/en/mcp">
                        https://code.zy.com/docs/en/mcp
                      </Link>{' '}
                      {tSync('mcp.forHelp')}
                    </Text>
                  }
                </Box>
              }
            </Box>
          }
        </Dialog>
      }
      {
        <Box paddingX={1}>
          <Text dimColor={true} italic={true}>
            <Byline>
              <KeyboardShortcutHint shortcut={'\u2191\u2193'} action="navigate" />
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={tSync('common.cancel')}
              />
            </Byline>
          </Text>
        </Box>
      }
    </Box>
  )
}
