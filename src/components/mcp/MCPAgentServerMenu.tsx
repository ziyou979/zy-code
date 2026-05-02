import figures from 'figures'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { Box, color, Link, Text, useTheme } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { AuthenticationCancelledError, performMCPOAuthFlow } from '../../services/mcp/auth.js'
import { capitalize } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Select } from '../CustomSelect/index.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Spinner } from '../Spinner.js'
import type { AgentMcpServerInfo } from './types.js'
type Props = {
  agentServer: AgentMcpServerInfo
  onCancel: () => void
  onComplete?: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}

/**
 * Menu for agent-specific MCP servers.
 * These servers are defined in agent frontmatter and only connect when the agent runs.
 * For HTTP/SSE servers, this allows pre-authentication before using the agent.
 */
export function MCPAgentServerMenu({ agentServer, onCancel, onComplete }: Props): React.ReactNode {
  const [theme] = useTheme()
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  const authAbortControllerRef = useRef<AbortController | null>(null)

  // Abort OAuth flow on unmount so the callback server is closed even if a
  // parent component's Esc handler navigates away before ours fires.
  useEffect(() => () => authAbortControllerRef.current?.abort(), [])

  // Handle ESC to cancel authentication flow
  const handleEscCancel = useCallback(() => {
    if (isAuthenticating) {
      authAbortControllerRef.current?.abort()
      authAbortControllerRef.current = null
      setIsAuthenticating(false)
      setAuthorizationUrl(null)
    }
  }, [isAuthenticating])
  useKeybinding('confirm:no', handleEscCancel, {
    context: 'Confirmation',
    isActive: isAuthenticating,
  })
  const handleAuthenticate = useCallback(async () => {
    if (!(agentServer as any).needsAuth || !(agentServer as any).url) {
      return
    }
    setIsAuthenticating(true)
    setError(null)
    const controller = new AbortController()
    authAbortControllerRef.current = controller
    try {
      // Create a temporary config for OAuth
      const tempConfig = {
        type: (agentServer as any).transport as 'http' | 'sse',
        url: (agentServer as any).url,
      }
      await performMCPOAuthFlow(
        (agentServer as any).name,
        tempConfig,
        setAuthorizationUrl,
        controller.signal,
      )
      onComplete?.(tSync('mcp.authSuccessfulConnected', { serverName: (agentServer as any).name }))
    } catch (err) {
      // Don't show error if it was a cancellation
      if (err instanceof Error && !(err instanceof AuthenticationCancelledError)) {
        setError(err.message)
      }
    } finally {
      setIsAuthenticating(false)
      authAbortControllerRef.current = null
    }
  }, [agentServer, onComplete])
  const capitalizedServerName = capitalize(String((agentServer as any).name))
  if (isAuthenticating) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="zy">
          {tSync('mcp.authenticatingWith', { serverName: (agentServer as any).name })}
        </Text>
        <Box>
          <Spinner />
          <Text> {tSync('mcp.browserWillOpen')}</Text>
        </Box>
        {authorizationUrl && (
          <Box flexDirection="column">
            <Text dimColor>{tSync('mcp.copyUrlManually')} </Text>
            <Link url={authorizationUrl} />
          </Box>
        )}
        <Box marginLeft={3}>
          <Text dimColor>{tSync('mcp.returnAfterAuth')}</Text>
        </Box>
      </Box>
    )
  }
  const menuOptions = []

  // Only show authenticate option for HTTP/SSE servers
  if ((agentServer as any).needsAuth) {
    menuOptions.push({
      label: (agentServer as any).isAuthenticated
        ? tSync('mcp.reauthenticate')
        : tSync('mcp.authenticate'),
      value: 'auth',
    })
  }
  menuOptions.push({
    label: tSync('mcp.back'),
    value: 'back',
  })
  return (
    <Dialog
      title={tSync('mcp.agentServerTitle', { serverName: capitalizedServerName })}
      subtitle={tSync('mcp.agentOnly')}
      onCancel={onCancel}
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>{tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName })}</Text>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description={tSync('mcp.goBack')}
            />
          </Byline>
        )
      }
    >
      <Box flexDirection="column" gap={0}>
        <Box>
          <Text bold>{tSync('mcp.typeLabel')} </Text>
          <Text dimColor>{(agentServer as any).transport}</Text>
        </Box>

        {(agentServer as any).url && (
          <Box>
            <Text bold>{tSync('mcp.urlLabel')} </Text>
            <Text dimColor>{(agentServer as any).url}</Text>
          </Box>
        )}

        {(agentServer as any).command && (
          <Box>
            <Text bold>{tSync('mcp.commandLabel')} </Text>
            <Text dimColor>{(agentServer as any).command}</Text>
          </Box>
        )}

        <Box>
          <Text bold>{tSync('mcp.usedByLabel')} </Text>
          <Text dimColor>{(agentServer as any).sourceAgents.join(', ')}</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold>{tSync('mcp.statusLabel')} </Text>
          <Text>
            {color('inactive', theme)(figures.radioOff)} {tSync('mcp.notConnectedAgentOnly')}
          </Text>
        </Box>

        {(agentServer as any).needsAuth && (
          <Box>
            <Text bold>{tSync('mcp.authLabel')} </Text>
            {(agentServer as any).isAuthenticated ? (
              <Text>
                {color('success', theme)(figures.tick)} {tSync('mcp.authenticated')}
              </Text>
            ) : (
              <Text>
                {color('warning', theme)(figures.triangleUpOutline)}{' '}
                {tSync('mcp.mayNeedAuthentication')}
              </Text>
            )}
          </Box>
        )}
      </Box>

      <Box>
        <Text dimColor>{tSync('mcp.agentOnlyConnects')}</Text>
      </Box>

      {error && (
        <Box>
          <Text color="error">
            {tSync('mcp.errorLabelMenu')} {error}
          </Text>
        </Box>
      )}

      <Box>
        <Select
          options={menuOptions}
          onChange={async (value) => {
            switch (value) {
              case 'auth':
                await handleAuthenticate()
                break
              case 'back':
                onCancel()
                break
            }
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
