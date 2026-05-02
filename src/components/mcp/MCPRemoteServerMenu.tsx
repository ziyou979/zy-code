import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { tSync } from 'src/i18n/index.js'
import type { CommandResultDisplay } from '../../commands.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { setClipboard } from '../../ink/termio/osc.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow menu navigation
import { Box, color, Link, Text, useInput, useTheme } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  AuthenticationCancelledError,
  performMCPOAuthFlow,
  revokeServerTokens,
} from '../../services/mcp/auth.js'
import { clearServerCache } from '../../services/mcp/client.js'
import { useMcpReconnect, useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js'
import {
  describeMcpConfigFilePath,
  excludeCommandsByServer,
  excludeResourcesByServer,
  excludeToolsByServer,
  filterMcpPromptsByServer,
} from '../../services/mcp/utils.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { capitalize } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Select } from '../CustomSelect/index.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Spinner } from '../Spinner.js'
import TextInput from '../TextInput.js'
import { CapabilitiesSection } from './CapabilitiesSection.js'
import type { ZyAIServerInfo, HTTPServerInfo, SSEServerInfo } from './types.js'
import { handleReconnectError, handleReconnectResult } from './utils/reconnectHelpers.js'
type Props = {
  server: SSEServerInfo | HTTPServerInfo | ZyAIServerInfo
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete?: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  borderless?: boolean
}
export function MCPRemoteServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: Props): React.ReactNode {
  const [theme] = useTheme()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const { columns: terminalColumns } = useTerminalSize()
  const [isAuthenticating, setIsAuthenticating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const mcp = useAppState((s) => s.mcp)
  const setAppState = useSetAppState()
  const [authorizationUrl, setAuthorizationUrl] = React.useState<string | null>(null)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const authAbortControllerRef = useRef<AbortController | null>(null)
  const [isZyAIAuthenticating, setIsZyAIAuthenticating] = useState(false)
  const [ZyAIAuthUrl, setZyAIAuthUrl] = useState<string | null>(null)
  const [isZyAIClearingAuth, setIsZyAIClearingAuth] = useState(false)
  const [ZyAIClearAuthUrl, setZyAIClearAuthUrl] = useState<string | null>(null)
  const [ZyAIClearAuthBrowserOpened, setZyAIClearAuthBrowserOpened] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const unmountedRef = useRef(false)
  const [callbackUrlInput, setCallbackUrlInput] = useState('')
  const [callbackUrlCursorOffset, setCallbackUrlCursorOffset] = useState(0)
  const [manualCallbackSubmit, setManualCallbackSubmit] = useState<((url: string) => void) | null>(
    null,
  )

  // If the component unmounts mid-auth (e.g. a parent component's Esc handler
  // navigates away before ours fires), abort the OAuth flow so the callback
  // server is closed. Without this, the server stays bound and the process
  // can outlive the terminal. Also clear the copy-feedback timer and mark
  // unmounted so the async setClipboard callback doesn't setUrlCopied /
  // schedule a new timer after unmount.
  useEffect(
    () => () => {
      unmountedRef.current = true
      authAbortControllerRef.current?.abort()
      if (copyTimeoutRef.current !== undefined) {
        clearTimeout(copyTimeoutRef.current)
      }
    },
    [],
  )

  // A server is effectively authenticated if:
  // 1. It has OAuth tokens (server.isAuthenticated), OR
  // 2. It's connected and has tools (meaning it's working via some auth mechanism)
  const isEffectivelyAuthenticated =
    (server as any).isAuthenticated ||
    ((server as any).client.type === 'connected' && serverToolsCount > 0)
  const reconnectMcpServer = useMcpReconnect()
  const handleZyAIAuthComplete = React.useCallback(async () => {
    setIsZyAIAuthenticating(false)
    setZyAIAuthUrl(null)
    setIsReconnecting(true)
    try {
      const result = await reconnectMcpServer(server.name)
      const success = result.client.type === 'connected'
      logEvent('zy_Zyai_mcp_auth_completed', {
        success,
      })
      if (success) {
        onComplete?.(tSync('mcp.authSuccessfulConnected', { serverName: server.name }))
      } else if (result.client.type === 'needs-auth') {
        onComplete?.(tSync('mcp.authSuccessfulNeedsAuth'))
      } else {
        onComplete?.(tSync('mcp.authSuccessfulReconnectFailed'))
      }
    } catch (err) {
      logEvent('zy_Zyai_mcp_auth_completed', {
        success: false,
      })
      onComplete?.(handleReconnectError(err, server.name))
    } finally {
      setIsReconnecting(false)
    }
  }, [reconnectMcpServer, server.name, onComplete])
  const handleZyAIClearAuthComplete = React.useCallback(async () => {
    await clearServerCache(server.name, {
      ...(server as any).config,
      scope: (server as any).scope,
    })
    setAppState((prev) => {
      const newClients = prev.mcp.clients.map((c) =>
        c.name === server.name
          ? {
              ...c,
              type: 'needs-auth' as const,
            }
          : c,
      )
      const newTools = excludeToolsByServer(prev.mcp.tools, server.name)
      const newCommands = excludeCommandsByServer(prev.mcp.commands, server.name)
      const newResources = excludeResourcesByServer(prev.mcp.resources, server.name)
      return {
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: newClients,
          tools: newTools,
          commands: newCommands,
          resources: newResources,
        },
      }
    })
    logEvent('zy_Zyai_mcp_clear_auth_completed', {})
    onComplete?.(tSync('mcp.disconnectedFrom', { serverName: server.name }))
    setIsZyAIClearingAuth(false)
    setZyAIClearAuthUrl(null)
    setZyAIClearAuthBrowserOpened(false)
  }, [server.name, (server as any).config, (server as any).scope, setAppState, onComplete])

  // Escape to cancel authentication flow
  useKeybinding(
    'confirm:no',
    () => {
      authAbortControllerRef.current?.abort()
      authAbortControllerRef.current = null
      setIsAuthenticating(false)
      setAuthorizationUrl(null)
    },
    {
      context: 'Confirmation',
      isActive: isAuthenticating,
    },
  )

  // Escape to cancel Zy AI authentication
  useKeybinding(
    'confirm:no',
    () => {
      setIsZyAIAuthenticating(false)
      setZyAIAuthUrl(null)
    },
    {
      context: 'Confirmation',
      isActive: isZyAIAuthenticating,
    },
  )

  // Escape to cancel Zy AI clear auth
  useKeybinding(
    'confirm:no',
    () => {
      setIsZyAIClearingAuth(false)
      setZyAIClearAuthUrl(null)
      setZyAIClearAuthBrowserOpened(false)
    },
    {
      context: 'Confirmation',
      isActive: isZyAIClearingAuth,
    },
  )

  // Return key handling for authentication flows and 'c' to copy URL
  useInput((input, key) => {
    if (key.return && isZyAIAuthenticating) {
      void handleZyAIAuthComplete()
    }
    if (key.return && isZyAIClearingAuth) {
      if (ZyAIClearAuthBrowserOpened) {
        void handleZyAIClearAuthComplete()
      } else {
        // First Enter: open the browser
        const connectorsUrl = `${getOauthConfig().CLAUDE_AI_ORIGIN}/settings/connectors`
        setZyAIClearAuthUrl(connectorsUrl)
        setZyAIClearAuthBrowserOpened(true)
        void openBrowser(connectorsUrl)
      }
    }
    if (input === 'c' && !urlCopied) {
      const urlToCopy = authorizationUrl || ZyAIAuthUrl || ZyAIClearAuthUrl
      if (urlToCopy) {
        void setClipboard(urlToCopy).then((raw) => {
          if (unmountedRef.current) return
          if (raw) process.stdout.write(raw)
          setUrlCopied(true)
          if (copyTimeoutRef.current !== undefined) {
            clearTimeout(copyTimeoutRef.current)
          }
          copyTimeoutRef.current = setTimeout(setUrlCopied, 2000, false)
        })
      }
    }
  })
  const capitalizedServerName = capitalize(String(server.name))

  // Count MCP prompts for this server (skills are shown in /skills, not here)
  const serverCommandsCount = filterMcpPromptsByServer(mcp.commands, server.name).length
  const toggleMcpServer = useMcpToggleEnabled()
  const handleZyAIAuth = React.useCallback(async () => {
    const zyAiBaseUrl = getOauthConfig().CLAUDE_AI_ORIGIN
    const accountInfo = getOauthAccountInfo()
    const orgUuid = accountInfo?.organizationUuid
    let authUrl: string
    if (orgUuid && (server as any).config.type === 'zyai-proxy' && (server as any).config.id) {
      // Use the direct auth URL with org and server IDs
      // Replace 'mcprs' prefix with 'mcpsrv' if present
      const serverId = (server as any).config.id.startsWith('mcprs')
        ? 'mcpsrv' + (server as any).config.id.slice(5)
        : (server as any).config.id
      const productSurface = encodeURIComponent(process.env.ZY_CODE_ENTRYPOINT || 'cli')
      authUrl = `${zyAiBaseUrl}/api/organizations/${orgUuid}/mcp/start-auth/${serverId}?product_surface=${productSurface}`
    } else {
      // Fall back to settings/connectors if we don't have the required IDs
      authUrl = `${zyAiBaseUrl}/settings/connectors`
    }
    setZyAIAuthUrl(authUrl)
    setIsZyAIAuthenticating(true)
    logEvent('zy_Zyai_mcp_auth_started', {})
    await openBrowser(authUrl)
  }, [(server as any).config])
  const handleZyAIClearAuth = React.useCallback(() => {
    setIsZyAIClearingAuth(true)
    logEvent('zy_Zyai_mcp_clear_auth_started', {})
  }, [])
  const handleToggleEnabled = React.useCallback(async () => {
    const wasEnabled = (server as any).client.type !== 'disabled'
    try {
      await toggleMcpServer(server.name)
      if ((server as any).config.type === 'zyai-proxy') {
        logEvent('zy_Zyai_mcp_toggle', {
          new_state: (wasEnabled
            ? 'disabled'
            : 'enabled') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // Return to the server list so user can continue managing other servers
      onCancel()
    } catch (err_0) {
      const action = wasEnabled ? tSync('mcp.disable') : tSync('mcp.enable')
      onComplete?.(
        tSync('mcp.failedToToggle', {
          action,
          serverName: server.name,
          error: errorMessage(err_0),
        }),
      )
    }
  }, [
    (server as any).client.type,
    (server as any).config.type,
    server.name,
    toggleMcpServer,
    onCancel,
    onComplete,
  ])
  const handleAuthenticate = React.useCallback(async () => {
    if ((server as any).config.type === 'zyai-proxy') return
    setIsAuthenticating(true)
    setError(null)
    const controller = new AbortController()
    authAbortControllerRef.current = controller
    try {
      // Revoke existing tokens if re-authenticating, but preserve step-up
      // auth state so the next OAuth flow can reuse cached scope/discovery.
      if ((server as any).isAuthenticated && (server as any).config) {
        await revokeServerTokens(server.name, (server as any).config, {
          preserveStepUpState: true,
        })
      }
      if ((server as any).config) {
        await performMCPOAuthFlow(
          server.name,
          (server as any).config,
          setAuthorizationUrl,
          controller.signal,
          {
            onWaitingForCallback: (submit) => {
              setManualCallbackSubmit(() => submit)
            },
          },
        )
        logEvent('zy_mcp_auth_config_authenticate', {
          wasAuthenticated: (server as any).isAuthenticated,
        })
        const result_0 = await reconnectMcpServer(server.name)
        if (result_0.client.type === 'connected') {
          const message = isEffectivelyAuthenticated
            ? tSync('mcp.authSuccessfulReconnected', { serverName: server.name })
            : tSync('mcp.authSuccessfulConnected', { serverName: server.name })
          onComplete?.(message)
        } else if (result_0.client.type === 'needs-auth') {
          onComplete?.(tSync('mcp.authSuccessfulNeedsAuth'))
        } else {
          // result.client.type === 'failed'
          logMCPDebug(server.name, `Reconnection failed after authentication`)
          onComplete?.(tSync('mcp.authSuccessfulReconnectFailed'))
        }
      }
    } catch (err_1) {
      // Don't show error if it was a cancellation
      if (err_1 instanceof Error && !(err_1 instanceof AuthenticationCancelledError)) {
        setError(err_1.message)
      }
    } finally {
      setIsAuthenticating(false)
      authAbortControllerRef.current = null
      setManualCallbackSubmit(null)
      setCallbackUrlInput('')
    }
  }, [
    (server as any).isAuthenticated,
    (server as any).config,
    server.name,
    onComplete,
    reconnectMcpServer,
    isEffectivelyAuthenticated,
  ])
  const handleClearAuth = async () => {
    if ((server as any).config.type === 'zyai-proxy') return
    if ((server as any).config) {
      // First revoke the authentication tokens and clear all auth state
      await revokeServerTokens(server.name, (server as any).config)
      logEvent('zy_mcp_auth_config_clear', {})

      // Disconnect the client and clear the cache
      await clearServerCache(server.name, {
        ...(server as any).config,
        scope: (server as any).scope,
      })

      // Update app state to remove the disconnected server's tools, commands, and resources
      setAppState((prev_0) => {
        const newClients_0 = prev_0.mcp.clients.map((c_0) =>
          // 'failed' is a misnomer here, but we don't really differentiate between "not connected" and "failed" at the moment
          c_0.name === server.name
            ? {
                ...c_0,
                type: 'failed' as const,
              }
            : c_0,
        )
        const newTools_0 = excludeToolsByServer(prev_0.mcp.tools, server.name)
        const newCommands_0 = excludeCommandsByServer(prev_0.mcp.commands, server.name)
        const newResources_0 = excludeResourcesByServer(prev_0.mcp.resources, server.name)
        return {
          ...prev_0,
          mcp: {
            ...prev_0.mcp,
            clients: newClients_0,
            tools: newTools_0,
            commands: newCommands_0,
            resources: newResources_0,
          },
        }
      })
      onComplete?.(tSync('mcp.authCleared', { serverName: server.name }))
    }
  }
  if (isAuthenticating) {
    // XAA: silent exchange (cached id_token → no browser), so don't claim
    // one will open. If IdP login IS needed, authorizationUrl populates and
    // the URL fallback block below still renders.
    const authCopy =
      (server as any).config.type !== 'zyai-proxy' && (server as any).config.oauth?.xaa
        ? ` ${tSync('mcp.authViaIdentityProvider')}`
        : ` ${tSync('mcp.browserWillOpen')}`
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="zy">{tSync('mcp.authenticatingWith', { serverName: server.name })}</Text>
        <Box>
          <Spinner />
          <Text>{authCopy}</Text>
        </Box>
        {authorizationUrl && (
          <Box flexDirection="column">
            <Box>
              <Text dimColor>{tSync('mcp.copyUrlManually')} </Text>
              {urlCopied ? (
                <Text color="success">({tSync('mcp.copied')})</Text>
              ) : (
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="c" action="copy" parens />
                </Text>
              )}
            </Box>
            <Link url={authorizationUrl} />
          </Box>
        )}
        {isAuthenticating && authorizationUrl && manualCallbackSubmit && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{tSync('mcp.pasteUrlFromBrowser')}</Text>
            <Box>
              <Text dimColor>URL {'>'} </Text>
              <TextInput
                value={callbackUrlInput}
                onChange={setCallbackUrlInput}
                onSubmit={(value: string) => {
                  manualCallbackSubmit(value.trim())
                  setCallbackUrlInput('')
                }}
                cursorOffset={callbackUrlCursorOffset}
                onChangeCursorOffset={setCallbackUrlCursorOffset}
                columns={terminalColumns - 8}
              />
            </Box>
          </Box>
        )}
        <Box marginLeft={3}>
          <Text dimColor>{tSync('mcp.returnAfterAuth')}</Text>
        </Box>
      </Box>
    )
  }
  if (isZyAIAuthenticating) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="zy">{tSync('mcp.authenticatingWith', { serverName: server.name })}</Text>
        <Box>
          <Spinner />
          <Text> {tSync('mcp.browserWillOpen')}</Text>
        </Box>
        {ZyAIAuthUrl && (
          <Box flexDirection="column">
            <Box>
              <Text dimColor>{tSync('mcp.copyUrlManually')} </Text>
              {urlCopied ? (
                <Text color="success">({tSync('mcp.copied')})</Text>
              ) : (
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="c" action="copy" parens />
                </Text>
              )}
            </Box>
            <Link url={ZyAIAuthUrl} />
          </Box>
        )}
        <Box marginLeft={3} flexDirection="column">
          <Text color="permission">{tSync('mcp.pressEnterAfterAuth')}</Text>
          <Text dimColor italic>
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description={tSync('mcp.back')}
            />
          </Text>
        </Box>
      </Box>
    )
  }
  if (isZyAIClearingAuth) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="zy">{tSync('mcp.clearAuthTitle', { serverName: server.name })}</Text>
        {ZyAIClearAuthBrowserOpened ? (
          <>
            <Text>{tSync('mcp.findServerAndDisconnect')}</Text>
            {ZyAIClearAuthUrl && (
              <Box flexDirection="column">
                <Box>
                  <Text dimColor>{tSync('mcp.copyUrlManually')} </Text>
                  {urlCopied ? (
                    <Text color="success">({tSync('mcp.copied')})</Text>
                  ) : (
                    <Text dimColor>
                      <KeyboardShortcutHint shortcut="c" action="copy" parens />
                    </Text>
                  )}
                </Box>
                <Link url={ZyAIClearAuthUrl} />
              </Box>
            )}
            <Box marginLeft={3} flexDirection="column">
              <Text color="permission">{tSync('mcp.pressEnterWhenDone')}</Text>
              <Text dimColor italic>
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('mcp.back')}
                />
              </Text>
            </Box>
          </>
        ) : (
          <>
            <Text>{tSync('mcp.willOpenZyAi')}</Text>
            <Box marginLeft={3} flexDirection="column">
              <Text color="permission">{tSync('mcp.pressEnterToOpenBrowser')}</Text>
              <Text dimColor italic>
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('mcp.back')}
                />
              </Text>
            </Box>
          </>
        )}
      </Box>
    )
  }
  if (isReconnecting) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="text">{tSync('mcp.connectingTo', { serverName: server.name })}</Text>
        <Box>
          <Spinner />
          <Text> {tSync('mcp.establishingConnection')}</Text>
        </Box>
        <Text dimColor>{tSync('mcp.mayTakeAMoment')}</Text>
      </Box>
    )
  }
  const menuOptions = []

  // If server is disabled, show Enable first as the primary action
  if ((server as any).client.type === 'disabled') {
    menuOptions.push({
      label: tSync('mcp.enable'),
      value: 'toggle-enabled',
    })
  }
  if ((server as any).client.type === 'connected' && serverToolsCount > 0) {
    menuOptions.push({
      label: tSync('mcp.viewTools'),
      value: 'tools',
    })
  }
  if ((server as any).config.type === 'zyai-proxy') {
    if ((server as any).client.type === 'connected') {
      menuOptions.push({
        label: tSync('mcp.clearAuthentication'),
        value: 'zyai-clear-auth',
      })
    } else if ((server as any).client.type !== 'disabled') {
      menuOptions.push({
        label: tSync('mcp.authenticate'),
        value: 'zyai-auth',
      })
    }
  } else {
    if (isEffectivelyAuthenticated) {
      menuOptions.push({
        label: tSync('mcp.reauthenticate'),
        value: 'reauth',
      })
      menuOptions.push({
        label: tSync('mcp.clearAuthentication'),
        value: 'clear-auth',
      })
    }
    if (!isEffectivelyAuthenticated) {
      menuOptions.push({
        label: tSync('mcp.authenticate'),
        value: 'auth',
      })
    }
  }
  if ((server as any).client.type !== 'disabled') {
    if ((server as any).client.type !== 'needs-auth') {
      menuOptions.push({
        label: tSync('mcp.reconnect'),
        value: 'reconnectMcpServer',
      })
    }
    menuOptions.push({
      label: tSync('mcp.disable'),
      value: 'toggle-enabled',
    })
  }

  // If there are no other options, add a back option so Select handles escape
  if (menuOptions.length === 0) {
    menuOptions.push({
      label: tSync('mcp.back'),
      value: 'back',
    })
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
            ) : (server as any).client.type === 'needs-auth' ? (
              <Text>
                {color('warning', theme)(figures.triangleUpOutline)}{' '}
                {tSync('mcp.needsAuthentication')}
              </Text>
            ) : (
              <Text>
                {color('error', theme)(figures.cross)} {tSync('mcp.failed')}
              </Text>
            )}
          </Box>

          {(server as any).transport !== 'zyai-proxy' && (
            <Box>
              <Text bold>{tSync('mcp.authLabel')} </Text>
              {isEffectivelyAuthenticated ? (
                <Text>
                  {color('success', theme)(figures.tick)} {tSync('mcp.authenticated')}
                </Text>
              ) : (
                <Text>
                  {color('error', theme)(figures.cross)} {tSync('mcp.notAuthenticated')}
                </Text>
              )}
            </Box>
          )}

          <Box>
            <Text bold>{tSync('mcp.urlLabel')} </Text>
            <Text dimColor>{(server as any).config.url}</Text>
          </Box>

          <Box>
            <Text bold>{tSync('mcp.configLocationLabel')} </Text>
            <Text dimColor>{describeMcpConfigFilePath((server as any).scope)}</Text>
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

        {error && (
          <Box marginTop={1}>
            <Text color="error">
              {tSync('mcp.errorLabelMenu')} {error}
            </Text>
          </Box>
        )}

        {menuOptions.length > 0 && (
          <Box marginTop={1}>
            <Select
              options={menuOptions}
              onChange={async (value_0) => {
                switch (value_0) {
                  case 'tools':
                    onViewTools()
                    break
                  case 'auth':
                  case 'reauth':
                    await handleAuthenticate()
                    break
                  case 'clear-auth':
                    await handleClearAuth()
                    break
                  case 'zyai-auth':
                    await handleZyAIAuth()
                    break
                  case 'zyai-clear-auth':
                    handleZyAIClearAuth()
                    break
                  case 'reconnectMcpServer':
                    setIsReconnecting(true)
                    try {
                      const result_1 = await reconnectMcpServer(server.name)
                      if ((server as any).config.type === 'zyai-proxy') {
                        logEvent('zy_Zyai_mcp_reconnect', {
                          success: result_1.client.type === 'connected',
                        })
                      }
                      const { message: message_0 } = handleReconnectResult(result_1, server.name)
                      onComplete?.(message_0)
                    } catch (err_2) {
                      if ((server as any).config.type === 'zyai-proxy') {
                        logEvent('zy_Zyai_mcp_reconnect', {
                          success: false,
                        })
                      }
                      onComplete?.(handleReconnectError(err_2, server.name))
                    } finally {
                      setIsReconnecting(false)
                    }
                    break
                  case 'toggle-enabled':
                    await handleToggleEnabled()
                    break
                  case 'back':
                    onCancel()
                    break
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
            <>{tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName })}</>
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
