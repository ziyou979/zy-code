import { fig } from '../../constants/figures.js'
import { useEffect, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { Box, color, Text, useTheme } from '../../ink.js'
import { useMcpReconnect } from '../../services/mcp/MCPConnectionManager.js'
import { useAppStateStore } from '../../state/AppState.js'
import { Spinner } from '../Spinner.js'

type Props = {
  serverName: string
  onComplete: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
export function MCPReconnect({ serverName, onComplete }: Props) {
  const [theme] = useTheme()
  const store = useAppStateStore()
  const reconnectMcpServer = useMcpReconnect()
  const [isReconnecting, setIsReconnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const attemptReconnect = async function attemptReconnect() {
      try {
        const server = store.getState().mcp.clients.find((c) => c.name === serverName)
        if (!server) {
          setError(tSync('mcp.serverNotFound', { serverName }))
          setIsReconnecting(false)
          onComplete(tSync('mcp.serverNotFound', { serverName }))
          return
        }
        const result = await reconnectMcpServer(serverName)
        switch (result.client.type) {
          case 'connected': {
            setIsReconnecting(false)
            onComplete(tSync('mcp.successfullyReconnected', { serverName }))
            break
          }
          case 'needs-auth': {
            setError(tSync('mcp.requiresAuthentication', { serverName }))
            setIsReconnecting(false)
            onComplete(tSync('mcp.requiresAuthUseMcp', { serverName }))
            break
          }
          case 'pending':
          case 'failed':
          case 'disabled': {
            setError(tSync('mcp.failedToReconnectShort', { serverName }))
            setIsReconnecting(false)
            onComplete(tSync('mcp.reconnectToFailed', { serverName }))
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        setIsReconnecting(false)
        onComplete(tSync('mcp.errorGeneric', { error: errorMessage }))
      }
    }
    attemptReconnect()
  }, [serverName, reconnectMcpServer, store, onComplete])
  if (isReconnecting) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {
          <Text color="text">
            {tSync('mcp.reconnectingTo', { serverName })} <Text bold={true}>{serverName}</Text>
          </Text>
        }
        {
          <Box>
            <Spinner />
            <Text> {tSync('mcp.establishingConnection')}</Text>
          </Box>
        }
      </Box>
    )
  }
  if (error) {
    const errorIcon = color('error', theme)(fig.cross)
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {
          <Box>
            {<Text>{errorIcon} </Text>}
            {<Text color="error">{tSync('mcp.failedToReconnect', { serverName })}</Text>}
          </Box>
        }
        {<Text dimColor={true}>{tSync('mcp.reconnectError', { error })}</Text>}
      </Box>
    )
  }
  return null
}
