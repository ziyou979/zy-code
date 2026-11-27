import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

type Props = {
  mcpClients?: MCPServerConnection[]
}
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []
export function useMcpConnectivityStatus({ mcpClients = EMPTY_MCP_CLIENTS }: Props) {
  const { addNotification } = useNotifications()
  useEffect(() => {
    const failedLocalClients = mcpClients.filter(
      (client) =>
        client.type === 'failed' &&
        client.config.type !== 'sse-ide' &&
        client.config.type !== 'ws-ide',
    )
    const needsAuthLocalServers = mcpClients.filter((client) => client.type === 'needs-auth')
    if (failedLocalClients.length === 0 && needsAuthLocalServers.length === 0) {
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
  }, [addNotification, mcpClients])
}
