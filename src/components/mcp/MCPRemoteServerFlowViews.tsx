import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Link, Text } from '../../ink.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Spinner } from '../Spinner.js'
import TextInput from '../TextInput.js'

type CopyableUrlProps = {
  url: string
  urlCopied: boolean
}

function CopyableUrl({ url, urlCopied }: CopyableUrlProps): React.ReactNode {
  return (
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
      <Link url={url} />
    </Box>
  )
}

type RemoteOAuthAuthenticatingViewProps = {
  serverName: string
  authCopy: string
  authorizationUrl: string | null
  urlCopied: boolean
  callbackUrlInput: string
  onChangeCallbackUrlInput: (value: string) => void
  callbackUrlCursorOffset: number
  onChangeCallbackUrlCursorOffset: (value: number) => void
  onSubmitManualCallback: ((url: string) => void) | null
  terminalColumns: number
}

export function RemoteOAuthAuthenticatingView({
  serverName,
  authCopy,
  authorizationUrl,
  urlCopied,
  callbackUrlInput,
  onChangeCallbackUrlInput,
  callbackUrlCursorOffset,
  onChangeCallbackUrlCursorOffset,
  onSubmitManualCallback,
  terminalColumns,
}: RemoteOAuthAuthenticatingViewProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} padding={1}>
      <Text color="zy">{tSync('mcp.authenticatingWith', { serverName })}</Text>
      <Box>
        <Spinner />
        <Text>{authCopy}</Text>
      </Box>
      {authorizationUrl && <CopyableUrl url={authorizationUrl} urlCopied={urlCopied} />}
      {authorizationUrl && onSubmitManualCallback && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{tSync('mcp.pasteUrlFromBrowser')}</Text>
          <Box>
            <Text dimColor>URL {'>'} </Text>
            <TextInput
              value={callbackUrlInput}
              onChange={onChangeCallbackUrlInput}
              onSubmit={(value: string) => {
                onSubmitManualCallback(value.trim())
                onChangeCallbackUrlInput('')
              }}
              cursorOffset={callbackUrlCursorOffset}
              onChangeCursorOffset={onChangeCallbackUrlCursorOffset}
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

type RemoteZyAiAuthenticatingViewProps = {
  serverName: string
  authUrl: string | null
  urlCopied: boolean
}

export function RemoteZyAiAuthenticatingView({
  serverName,
  authUrl,
  urlCopied,
}: RemoteZyAiAuthenticatingViewProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} padding={1}>
      <Text color="zy">{tSync('mcp.authenticatingWith', { serverName })}</Text>
      <Box>
        <Spinner />
        <Text> {tSync('mcp.browserWillOpen')}</Text>
      </Box>
      {authUrl && <CopyableUrl url={authUrl} urlCopied={urlCopied} />}
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

type RemoteZyAiClearAuthViewProps = {
  serverName: string
  clearAuthUrl: string | null
  browserOpened: boolean
  urlCopied: boolean
}

export function RemoteZyAiClearAuthView({
  serverName,
  clearAuthUrl,
  browserOpened,
  urlCopied,
}: RemoteZyAiClearAuthViewProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} padding={1}>
      <Text color="zy">{tSync('mcp.clearAuthTitle', { serverName })}</Text>
      {browserOpened ? (
        <>
          <Text>{tSync('mcp.findServerAndDisconnect')}</Text>
          {clearAuthUrl && <CopyableUrl url={clearAuthUrl} urlCopied={urlCopied} />}
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

type RemoteReconnectingViewProps = {
  serverName: string
}

export function RemoteReconnectingView({
  serverName,
}: RemoteReconnectingViewProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1} padding={1}>
      <Text color="text">{tSync('mcp.connectingTo', { serverName })}</Text>
      <Box>
        <Spinner />
        <Text> {tSync('mcp.establishingConnection')}</Text>
      </Box>
      <Text dimColor>{tSync('mcp.mayTakeAMoment')}</Text>
    </Box>
  )
}
