import React, { useEffect, useRef, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import type { CommandResultDisplay } from '../../commands/index.js'
import { CROSS, RADIO_OFF, TICK, TRIANGLE_UP_OUTLINE } from '../../constants/figures.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { setClipboard } from '../../ink/termio/osc.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow menu navigation
import { Box, color, Text, useInput, useTheme } from '../../ink/index.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  AuthenticationCancelledError,
  performMCPOAuthFlow,
  revokeServerTokens,
} from '../../services/mcp/auth.js'
import { clearServerCache } from '../../services/mcp/client.js'
import { useMcpReconnect, useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js'
import type {
  ConfigScope,
  MCPServerConnection,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpZyAIProxyServerConfig,
} from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  excludeCommandsByServer,
  excludeResourcesByServer,
  excludeToolsByServer,
  filterMcpPromptsByServer,
} from '../../services/mcp/utils.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../services/infra/log.js'
import { capitalize } from '../../utils/stringUtils.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Select } from '../CustomSelect/index.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { CapabilitiesSection } from './CapabilitiesSection.js'
import type { HTTPServerInfo, SSEServerInfo, ZyAIServerInfo } from '../../services/mcp/viewTypes.js'
import { handleReconnectError, handleReconnectResult } from './utils/ReconnectHelpers.js'
import {
  RemoteOAuthAuthenticatingView,
  RemoteReconnectingView,
} from './MCPRemoteServerFlowViews.js'

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

type RemoteServerRuntimeConfig =
  | (McpHTTPServerConfig & { scope: ConfigScope })
  | (McpSSEServerConfig & { scope: ConfigScope })
  | (McpZyAIProxyServerConfig & { scope: ConfigScope })

type RemoteServerRuntimeState = {
  client: MCPServerConnection
  config: RemoteServerRuntimeConfig
  scope: ConfigScope
  isAuthenticated?: boolean
}

export function MCPRemoteServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: Props): React.ReactNode {
  // 远端 MCP 菜单会读取连接态和解析后的配置字段，运行时对象比视图类型多这些能力。
  const srv = server as Props['server'] & RemoteServerRuntimeState
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
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    srv.isAuthenticated ||
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    (srv.client.type === 'connected' && serverToolsCount > 0)
  const reconnectMcpServer = useMcpReconnect()
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

  // Return key handling for authentication flows and 'c' to copy URL
  useInput((input, key) => {
    if (input === 'c' && !urlCopied) {
      const urlToCopy = authorizationUrl
      if (urlToCopy) {
        void setClipboard(urlToCopy).then((raw) => {
          if (unmountedRef.current) {
            return
          }
          if (raw) {
            process.stdout.write(raw)
          }
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
  const handleToggleEnabled = React.useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    const wasEnabled = srv.client.type !== 'disabled'
    try {
      await toggleMcpServer(server.name)
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      if (srv.config.type === 'zyai-proxy') {
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
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    srv.client.type,
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    srv.config.type,
    server.name,
    toggleMcpServer,
    onCancel,
    onComplete,
  ])
  const handleAuthenticate = React.useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    if (srv.config.type === 'zyai-proxy') {
      return
    }
    setIsAuthenticating(true)
    setError(null)
    const controller = new AbortController()
    authAbortControllerRef.current = controller
    try {
      // Revoke existing tokens if re-authenticating, but preserve step-up
      // auth state so the next OAuth flow can reuse cached scope/discovery.
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      if (srv.isAuthenticated && srv.config) {
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        await revokeServerTokens(server.name, srv.config, {
          preserveStepUpState: true,
        })
      }
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      if (srv.config) {
        await performMCPOAuthFlow(
          server.name,
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          srv.config,
          setAuthorizationUrl,
          controller.signal,
          {
            onWaitingForCallback: (submit) => {
              setManualCallbackSubmit(() => submit)
            },
          },
        )
        logEvent('zy_mcp_auth_config_authenticate', {
          // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
          wasAuthenticated: srv.isAuthenticated,
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
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    srv.isAuthenticated,
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    srv.config,
    server.name,
    onComplete,
    reconnectMcpServer,
    isEffectivelyAuthenticated,
  ])
  const handleClearAuth = async () => {
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    if (srv.config.type === 'zyai-proxy') {
      return
    }
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    if (srv.config) {
      // First revoke the authentication tokens and clear all auth state
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      await revokeServerTokens(server.name, srv.config)
      logEvent('zy_mcp_auth_config_clear', {})

      // Disconnect the client and clear the cache
      await clearServerCache(server.name, {
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        ...srv.config,
        // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
        scope: srv.scope,
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
      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
      srv.config.type !== 'zyai-proxy' && srv.config.oauth?.xaa
        ? ` ${tSync('mcp.authViaIdentityProvider')}`
        : ` ${tSync('mcp.browserWillOpen')}`
    return (
      <RemoteOAuthAuthenticatingView
        serverName={server.name}
        authCopy={authCopy}
        authorizationUrl={authorizationUrl}
        urlCopied={urlCopied}
        callbackUrlInput={callbackUrlInput}
        onChangeCallbackUrlInput={setCallbackUrlInput}
        callbackUrlCursorOffset={callbackUrlCursorOffset}
        onChangeCallbackUrlCursorOffset={setCallbackUrlCursorOffset}
        onSubmitManualCallback={manualCallbackSubmit}
        terminalColumns={terminalColumns}
      />
    )
  }
  if (isReconnecting) {
    return <RemoteReconnectingView serverName={server.name} />
  }
  const menuOptions = []

  // If server is disabled, show Enable first as the primary action
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  if (srv.client.type === 'disabled') {
    menuOptions.push({
      label: tSync('mcp.enable'),
      value: 'toggle-enabled',
    })
  }
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  if (srv.client.type === 'connected' && serverToolsCount > 0) {
    menuOptions.push({
      label: tSync('mcp.viewTools'),
      value: 'tools',
    })
  }
  // zy.ai connector（zyai-proxy）的认证依赖 Anthropic 后端，已移除，不提供认证操作。
  if (srv.config.type !== 'zyai-proxy') {
    if (isEffectivelyAuthenticated) {
      menuOptions.push({
        label: tSync('mcp.reauthenticate'),
        value: 'reauth',
      })
      menuOptions.push({
        label: tSync('mcp.clearAuthentication'),
        value: 'clear-auth',
      })
    } else {
      menuOptions.push({
        label: tSync('mcp.authenticate'),
        value: 'auth',
      })
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
  if (srv.client.type !== 'disabled') {
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    if (srv.client.type !== 'needs-auth') {
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
            {srv.client.type === 'disabled' ? (
              <Text>
                {color('inactive', theme)(RADIO_OFF)} {tSync('mcp.disabled')}
              </Text>
            ) : srv.client.type === 'connected' ? (
              <Text>
                {color('success', theme)(TICK)} {tSync('mcp.connected')}
              </Text>
            ) : srv.client.type === 'pending' ? (
              <>
                <Text dimColor>{RADIO_OFF}</Text>
                <Text> {tSync('mcp.connecting')}</Text>
              </>
            ) : srv.client.type === 'needs-auth' ? (
              <Text>
                {color('warning', theme)(TRIANGLE_UP_OUTLINE)} {tSync('mcp.needsAuthentication')}
              </Text>
            ) : (
              <Text>
                {color('error', theme)(CROSS)} {tSync('mcp.failed')}
              </Text>
            )}
          </Box>

          {srv.config.type !== 'zyai-proxy' && (
            <Box>
              <Text bold>{tSync('mcp.authLabel')} </Text>
              {isEffectivelyAuthenticated ? (
                <Text>
                  {color('success', theme)(TICK)} {tSync('mcp.authenticated')}
                </Text>
              ) : (
                <Text>
                  {color('error', theme)(CROSS)} {tSync('mcp.notAuthenticated')}
                </Text>
              )}
            </Box>
          )}

          <Box>
            <Text bold>{tSync('mcp.urlLabel')} </Text>
            <Text dimColor>{srv.config.url}</Text>
          </Box>

          <Box>
            <Text bold>{tSync('mcp.configLocationLabel')} </Text>
            <Text dimColor>{describeMcpConfigFilePath(srv.scope)}</Text>
          </Box>

          {srv.client.type === 'connected' && (
            <CapabilitiesSection
              serverToolsCount={serverToolsCount}
              serverPromptsCount={serverCommandsCount}
              serverResourcesCount={mcp.resources[server.name]?.length || 0}
            />
          )}

          {srv.client.type === 'connected' && serverToolsCount > 0 && (
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
              onChange={async (value_0: string) => {
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
                  case 'reconnectMcpServer':
                    setIsReconnecting(true)
                    try {
                      const result_1 = await reconnectMcpServer(server.name)
                      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
                      if (srv.config.type === 'zyai-proxy') {
                        logEvent('zy_Zyai_mcp_reconnect', {
                          success: result_1.client.type === 'connected',
                        })
                      }
                      const { message: message_0 } = handleReconnectResult(result_1, server.name)
                      onComplete?.(message_0)
                    } catch (err_2) {
                      // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
                      if (srv.config.type === 'zyai-proxy') {
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
