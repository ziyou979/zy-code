import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { hasZyAiMcpEverConnected } from '../../services/mcp/zyai.js'

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
              {tSync(
                failedLocalClients.length === 1
                  ? 'notif.mcpServerFailed'
                  : 'notif.mcpServersFailed',
                { count: failedLocalClients.length },
              )}
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
              {tSync(
                failedZyAiClients.length === 1
                  ? 'notif.zyaiConnectorUnavailable'
                  : 'notif.zyaiConnectorsUnavailable',
                { count: failedZyAiClients.length },
              )}
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
              {tSync(
                needsAuthLocalServers.length === 1
                  ? 'notif.mcpServerNeedsAuth'
                  : 'notif.mcpServersNeedAuth',
                { count: needsAuthLocalServers.length },
              )}
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
              {tSync(
                needsAuthZyAiServers.length === 1
                  ? 'notif.zyaiConnectorNeedsAuth'
                  : 'notif.zyaiConnectorsNeedAuth',
                { count: needsAuthZyAiServers.length },
              )}
            </Text>
            <Text dimColor={true}> · /mcp</Text>
          </>
        ),
        priority: 'medium',
      })
    }
  }, [addNotification, mcpClients])
}
