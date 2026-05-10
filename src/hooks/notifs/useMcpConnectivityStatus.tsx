import * as React from 'react'
import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { Text } from '../../ink.js'
import { hasZyAiMcpEverConnected } from '../../services/mcp/zyai.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
type Props = {
  mcpClients?: MCPServerConnection[]
}
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []
export function useMcpConnectivityStatus({ mcpClients = EMPTY_MCP_CLIENTS }: Props) {
  const { addNotification } = useNotifications()
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    const failedLocalClients = mcpClients.filter(
      (client) =>
        client.type === 'failed' &&
        client.config.type !== 'sse-ide' &&
        client.config.type !== 'ws-ide' &&
        client.config.type !== 'zyai-proxy',
    )
    const failedZyAiClients = mcpClients.filter(
      (client) =>
        client.type === 'failed' &&
        client.config.type === 'zyai-proxy' &&
        hasZyAiMcpEverConnected(client.name),
    )
    const needsAuthLocalServers = mcpClients.filter(
      (client) => client.type === 'needs-auth' && client.config.type !== 'zyai-proxy',
    )
    const needsAuthZyAiServers = mcpClients.filter(
      (client) =>
        client.type === 'needs-auth' &&
        client.config.type === 'zyai-proxy' &&
        hasZyAiMcpEverConnected(client.name),
    )
    if (
      failedLocalClients.length === 0 &&
      failedZyAiClients.length === 0 &&
      needsAuthLocalServers.length === 0 &&
      needsAuthZyAiServers.length === 0
    ) {
      return
    }
    if (failedLocalClients.length > 0) {
      addNotification({
        key: 'mcp-failed',
        jsx: (
          <>
            <Text color="error">
              {failedLocalClients.length} MCP{' '}
              {failedLocalClients.length === 1 ? 'server' : 'servers'} failed
            </Text>
            <Text dimColor={true}> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
    if (failedZyAiClients.length > 0) {
      addNotification({
        key: 'mcp-zyai-failed',
        jsx: (
          <>
            <Text color="error">
              {failedZyAiClients.length} zy.ai{' '}
              {failedZyAiClients.length === 1 ? 'connector' : 'connectors'} unavailable
            </Text>
            <Text dimColor={true}> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
    if (needsAuthLocalServers.length > 0) {
      addNotification({
        key: 'mcp-needs-auth',
        jsx: (
          <>
            <Text color="warning">
              {needsAuthLocalServers.length} MCP{' '}
              {needsAuthLocalServers.length === 1 ? 'server needs' : 'servers need'} auth
            </Text>
            <Text dimColor={true}> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
    if (needsAuthZyAiServers.length > 0) {
      addNotification({
        key: 'mcp-zyai-needs-auth',
        jsx: (
          <>
            <Text color="warning">
              {needsAuthZyAiServers.length} zy.ai{' '}
              {needsAuthZyAiServers.length === 1 ? 'connector needs' : 'connectors need'} auth
            </Text>
            <Text dimColor={true}> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
  }, [addNotification, mcpClients])
}
