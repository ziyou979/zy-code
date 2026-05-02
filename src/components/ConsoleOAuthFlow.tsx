import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { installOAuthTokens } from '../cli/handlers/auth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { setClipboard } from '../ink/termio/osc.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { Box, Link, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getSSLErrorHint } from '../services/api/errorUtils.js'
import { sendNotification } from '../services/notifier.js'
import { OAuthService } from '../services/oauth/index.js'
import { getOauthAccountInfo, validateForceLoginOrg } from '../utils/auth.js'
import { logError } from '../utils/log.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/select.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'
import { tSync } from 'src/i18n/index.js'
type Props = {
  onDone(): void
  startingMessage?: string
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'zyai' | 'console'
}
type OAuthStatus =
  | {
      state: 'idle'
    } // Initial state, waiting to select login method
  | {
      state: 'platform_setup'
    } // Show platform setup info (Bedrock/Vertex/Foundry)
  | {
      state: 'ready_to_start'
    } // Flow started, waiting for browser to open
  | {
      state: 'waiting_for_login'
      url: string
    } // Browser opened, waiting for user to login
  | {
      state: 'creating_api_key'
    } // Got access token, creating API key
  | {
      state: 'about_to_retry'
      nextState: OAuthStatus
    }
  | {
      state: 'success'
      token?: string
    }
  | {
      state: 'error'
      message: string
      toRetry?: OAuthStatus
    }
const PASTE_HERE_MSG = 'Paste code here if prompted > '
export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod: forceLoginMethodProp,
}: Props): React.ReactNode {
  const settings = getSettings_DEPRECATED() || {}
  const forceLoginMethod = forceLoginMethodProp ?? settings.forceLoginMethod
  const orgUUID = settings.forceLoginOrgUUID
  const forcedMethodMessage =
    forceLoginMethod === 'zyai'
      ? 'Login method pre-selected: Subscription Plan (Zy Pro/Max)'
      : forceLoginMethod === 'console'
        ? 'Login method pre-selected: API Usage Billing (Anthropic Console)'
        : null
  const terminal = useTerminalNotification()
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>(() => {
    if (mode === 'setup-token') {
      return {
        state: 'ready_to_start',
      }
    }
    if (forceLoginMethod === 'zyai' || forceLoginMethod === 'console') {
      return {
        state: 'ready_to_start',
      }
    }
    return {
      state: 'idle',
    }
  })
  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [oauthService] = useState(() => new OAuthService())
  const [loginWithZyAi, setLoginWithZyAi] = useState(() => {
    // Use Zy AI auth for setup-token mode to support user:inference scope
    return mode === 'setup-token' || forceLoginMethod === 'zyai'
  })
  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically. In this flow we expect the user to
  // copy the code from the browser and paste it in the terminal
  const [showPastePrompt, setShowPastePrompt] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1

  // Log forced login method on mount
  useEffect(() => {
    if (forceLoginMethod === 'zyai') {
      logEvent('zy_oauth_Zyai_forced', {})
    } else if (forceLoginMethod === 'console') {
      logEvent('zy_oauth_console_forced', {})
    }
  }, [forceLoginMethod])

  // Retry logic
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(setOAuthStatus, 1000, oauthStatus.nextState)
      return () => clearTimeout(timer)
    }
  }, [oauthStatus])

  // Handle Enter to continue on success state
  useKeybinding(
    'confirm:yes',
    () => {
      logEvent('zy_oauth_success', {
        loginWithZyAi,
      })
      onDone()
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'success' && mode !== 'setup-token',
    },
  )

  // Handle Enter to continue from platform setup
  useKeybinding(
    'confirm:yes',
    () => {
      setOAuthStatus({
        state: 'idle',
      })
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'platform_setup',
    },
  )

  // Handle Enter to retry on error state
  useKeybinding(
    'confirm:yes',
    () => {
      if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
        setPastedCode('')
        setOAuthStatus({
          state: 'about_to_retry',
          nextState: oauthStatus.toRetry,
        })
      }
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'error' && !!oauthStatus.toRetry,
    },
  )
  useEffect(() => {
    if (
      pastedCode === 'c' &&
      oauthStatus.state === 'waiting_for_login' &&
      showPastePrompt &&
      !urlCopied
    ) {
      void setClipboard(oauthStatus.url).then((raw) => {
        if (raw) process.stdout.write(raw)
        setUrlCopied(true)
        setTimeout(setUrlCopied, 2000, false)
      })
      setPastedCode('')
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied])
  async function handleSubmitCode(value: string, url: string) {
    try {
      // Expecting format "authorizationCode#state" from the authorization callback URL
      const [authorizationCode, state] = value.split('#')
      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: tSync('oauth.invalidCode'),
          toRetry: {
            state: 'waiting_for_login',
            url,
          },
        })
        return
      }

      // Track which path the user is taking (manual code entry)
      logEvent('zy_oauth_manual_entry', {})
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state,
      })
    } catch (err: unknown) {
      logError(err)
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: {
          state: 'waiting_for_login',
          url,
        },
      })
    }
  }
  const startOAuth = useCallback(async () => {
    try {
      logEvent('zy_oauth_flow_start', {
        loginWithZyAi,
      })
      const result = await oauthService
        .startOAuthFlow(
          async (url_0) => {
            setOAuthStatus({
              state: 'waiting_for_login',
              url: url_0,
            })
            setTimeout(setShowPastePrompt, 3000, true)
          },
          {
            loginWithZyAi,
            inferenceOnly: mode === 'setup-token',
            expiresIn: mode === 'setup-token' ? 365 * 24 * 60 * 60 : undefined,
            // 1 year for setup-token
            orgUUID,
          },
        )
        .catch((err_1) => {
          const isTokenExchangeError = err_1.message.includes('Token exchange failed')
          // Enterprise TLS proxies (Zscaler et al.) intercept the token
          // exchange POST and cause cryptic SSL errors. Surface an
          // actionable hint so the user isn't stuck in a login loop.
          const sslHint_0 = getSSLErrorHint(err_1)
          setOAuthStatus({
            state: 'error',
            message:
              sslHint_0 ??
              (isTokenExchangeError
                ? 'Failed to exchange authorization code for access token. Please try again.'
                : err_1.message),
            toRetry:
              mode === 'setup-token'
                ? {
                    state: 'ready_to_start',
                  }
                : {
                    state: 'idle',
                  },
          })
          logEvent('zy_oauth_token_exchange_error', {
            error: err_1.message,
            ssl_error: sslHint_0 !== null,
          })
          throw err_1
        })
      if (mode === 'setup-token') {
        // For setup-token mode, return the OAuth access token directly (it can be used as an API key)
        // Don't save to keychain - the token is displayed for manual use with ZY_CODE_OAUTH_TOKEN
        setOAuthStatus({
          state: 'success',
          token: result.accessToken,
        })
      } else {
        await installOAuthTokens(result)
        const orgResult = await validateForceLoginOrg()
        if (!(orgResult as any).valid) {
          throw new Error((orgResult as any).message)
        }
        setOAuthStatus({
          state: 'success',
        })
        void sendNotification(
          {
            message: 'ZY Code login successful',
            notificationType: 'auth_success',
          },
          terminal,
        )
      }
    } catch (err_0) {
      const errorMessage = (err_0 as Error).message
      const sslHint = getSSLErrorHint(err_0)
      setOAuthStatus({
        state: 'error',
        message: sslHint ?? errorMessage,
        toRetry: {
          state: mode === 'setup-token' ? 'ready_to_start' : 'idle',
        },
      })
      logEvent('zy_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ssl_error: sslHint !== null,
      })
    }
  }, [oauthService, setShowPastePrompt, loginWithZyAi, mode, orgUUID])
  const pendingOAuthStartRef = useRef(false)
  useEffect(() => {
    if (oauthStatus.state === 'ready_to_start' && !pendingOAuthStartRef.current) {
      pendingOAuthStartRef.current = true
      process.nextTick(
        (
          startOAuth_0: () => Promise<void>,
          pendingOAuthStartRef_0: React.MutableRefObject<boolean>,
        ) => {
          void startOAuth_0()
          pendingOAuthStartRef_0.current = false
        },
        startOAuth,
        pendingOAuthStartRef,
      )
    }
  }, [oauthStatus.state, startOAuth])

  // Auto-exit for setup-token mode
  useEffect(() => {
    if (mode === 'setup-token' && oauthStatus.state === 'success') {
      // Delay to ensure static content is fully rendered before exiting
      const timer_0 = setTimeout(
        (loginWithZyAi_0, onDone_0) => {
          logEvent('zy_oauth_success', {
            loginWithZyAi: loginWithZyAi_0,
          })
          // Don't clear terminal so the token remains visible
          onDone_0()
        },
        500,
        loginWithZyAi,
        onDone,
      )
      return () => clearTimeout(timer_0)
    }
  }, [mode, oauthStatus, loginWithZyAi, onDone])

  // Cleanup OAuth service when component unmounts
  useEffect(() => {
    return () => {
      oauthService.cleanup()
    }
  }, [oauthService])
  return (
    <Box flexDirection="column" gap={1}>
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && (
        <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>{tSync('oauth.browserNotOpened')} </Text>
            {urlCopied ? (
              <Text color="success">{tSync('oauth.copiedLabel')}</Text>
            ) : (
              <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>
            )}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>
      )}
      {mode === 'setup-token' && oauthStatus.state === 'success' && oauthStatus.token && (
        <Box key="tokenOutput" flexDirection="column" gap={1} paddingTop={1}>
          <Text color="success">{tSync('oauth.tokenCreatedSuccess')}</Text>
          <Box flexDirection="column" gap={1}>
            <Text>{tSync('oauth.yourTokenLabel')}</Text>
            <Text color="warning">{oauthStatus.token}</Text>
            <Text dimColor>{tSync('oauth.storeTokenSecurely')}</Text>
            <Text dimColor>{tSync('oauth.useTokenBySetting')}</Text>
          </Box>
        </Box>
      )}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <OAuthStatusMessage
          oauthStatus={oauthStatus}
          mode={mode}
          startingMessage={startingMessage}
          forcedMethodMessage={forcedMethodMessage}
          showPastePrompt={showPastePrompt}
          pastedCode={pastedCode}
          setPastedCode={setPastedCode}
          cursorOffset={cursorOffset}
          setCursorOffset={setCursorOffset}
          textInputColumns={textInputColumns}
          handleSubmitCode={handleSubmitCode}
          setOAuthStatus={setOAuthStatus}
          setLoginWithZyAi={setLoginWithZyAi}
        />
      </Box>
    </Box>
  )
}
type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus
  mode: 'login' | 'setup-token'
  startingMessage: string | undefined
  forcedMethodMessage: string | null
  showPastePrompt: boolean
  pastedCode: string
  setPastedCode: (value: string) => void
  cursorOffset: number
  setCursorOffset: (offset: number) => void
  textInputColumns: number
  handleSubmitCode: (value: string, url: string) => void
  setOAuthStatus: (status: OAuthStatus) => void
  setLoginWithZyAi: (value: boolean) => void
}
function OAuthStatusMessage({
  oauthStatus,
  mode,
  startingMessage,
  forcedMethodMessage,
  showPastePrompt,
  pastedCode,
  setPastedCode,
  cursorOffset,
  setCursorOffset,
  textInputColumns,
  handleSubmitCode,
  setOAuthStatus,
  setLoginWithZyAi,
}: OAuthStatusMessageProps) {
  switch (oauthStatus.state) {
    case 'idle': {
      const message = startingMessage ? startingMessage : tSync('oauth.introMessage')
      const heading = <Text bold={true}>{message}</Text>
      const subtitle = <Text>{tSync('oauth.selectLoginMethod')}</Text>
      const zyaiOption = {
        label: (
          <Text>
            {tSync('oauth.zyaiOptionLabel')}{' '}
            <Text dimColor={true}>{tSync('oauth.zyaiOptionDesc')}</Text>
            {'\n'}
          </Text>
        ),
        value: 'zyai',
      }
      const consoleOption = {
        label: (
          <Text>
            {tSync('oauth.consoleOptionLabel')}{' '}
            <Text dimColor={true}>{tSync('oauth.consoleOptionDesc')}</Text>
            {'\n'}
          </Text>
        ),
        value: 'console',
      }
      const options = [
        zyaiOption,
        consoleOption,
        {
          label: (
            <Text>
              {tSync('oauth.platformOptionLabel')}{' '}
              <Text dimColor={true}>{tSync('oauth.platformOptionDesc')}</Text>
              {'\n'}
            </Text>
          ),
          value: 'platform',
        },
      ]
      const selectBox = (
        <Box>
          <Select
            options={options}
            onChange={(value_0) => {
              if (value_0 === 'platform') {
                logEvent('zy_oauth_platform_selected', {})
                setOAuthStatus({
                  state: 'platform_setup',
                })
              } else {
                setOAuthStatus({
                  state: 'ready_to_start',
                })
                if (value_0 === 'zyai') {
                  logEvent('zy_oauth_Zyai_selected', {})
                  setLoginWithZyAi(true)
                } else {
                  logEvent('zy_oauth_console_selected', {})
                  setLoginWithZyAi(false)
                }
              }
            }}
          />
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {heading}
          {subtitle}
          {selectBox}
        </Box>
      )
    }
    case 'platform_setup': {
      const heading = <Text bold={true}>{tSync('oauth.usingThirdPartyPlatforms')}</Text>
      const description1 = <Text>{tSync('oauth.thirdPartyPlatformsDesc')}</Text>
      const description2 = <Text>{tSync('oauth.thirdPartyPlatformsEnterpriseHint')}</Text>
      const docHeading = <Text bold={true}>{tSync('oauth.documentation')}</Text>
      const bedrockLink = (
        <Text>
          · {tSync('oauth.bedrockLabel')}:{' '}
          <Link url="https://code.zy.com/docs/en/amazon-bedrock">
            https://code.zy.com/docs/en/amazon-bedrock
          </Link>
        </Text>
      )
      const foundryLink = (
        <Text>
          · {tSync('oauth.foundryLabel')}:{' '}
          <Link url="https://code.zy.com/docs/en/microsoft-foundry">
            https://code.zy.com/docs/en/microsoft-foundry
          </Link>
        </Text>
      )
      const linksBox = (
        <Box flexDirection="column" marginTop={1}>
          {docHeading}
          {bedrockLink}
          {foundryLink}
          <Text>
            · {tSync('oauth.vertexLabel')}:{' '}
            <Link url="https://code.zy.com/docs/en/google-vertex-ai">
              https://code.zy.com/docs/en/google-vertex-ai
            </Link>
          </Text>
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {heading}
          <Box flexDirection="column" gap={1}>
            {description1}
            {description2}
            {linksBox}
            <Box marginTop={1}>
              <Text dimColor={true}>{tSync('oauth.pressEnterToGoBack')}</Text>
            </Box>
          </Box>
        </Box>
      )
    }
    case 'waiting_for_login': {
      const forcedMsgBox = forcedMethodMessage && (
        <Box>
          <Text dimColor={true}>{forcedMethodMessage}</Text>
        </Box>
      )
      const openingBrowserBox = !showPastePrompt && (
        <Box>
          <Spinner />
          <Text>{tSync('oauth.openingBrowserToSignIn')}</Text>
        </Box>
      )
      const pasteInputBox = showPastePrompt && (
        <Box>
          <Text>{PASTE_HERE_MSG}</Text>
          <TextInput
            value={pastedCode}
            onChange={setPastedCode}
            onSubmit={(value) => handleSubmitCode(value, oauthStatus.url)}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={textInputColumns}
            mask="*"
          />
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1}>
          {forcedMsgBox}
          {openingBrowserBox}
          {pasteInputBox}
        </Box>
      )
    }
    case 'creating_api_key':
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>{tSync('oauth.creatingApiKey')}</Text>
          </Box>
        </Box>
      )
    case 'about_to_retry':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="permission">{tSync('oauth.retrying')}</Text>
        </Box>
      )
    case 'success': {
      const loginInfo =
        mode === 'setup-token' && oauthStatus.token ? null : (
          <>
            {getOauthAccountInfo()?.emailAddress ? (
              <Text dimColor={true}>
                {tSync('oauth.loggedInAs')} <Text>{getOauthAccountInfo()?.emailAddress}</Text>
              </Text>
            ) : null}
            <Text color="success">{tSync('oauth.loginSuccessful')}</Text>
          </>
        )
      return <Box flexDirection="column">{loginInfo}</Box>
    }
    case 'error': {
      const errorMsg = (
        <Text color="error">
          {tSync('oauth.errorPrefix')} {oauthStatus.message}
        </Text>
      )
      const retryBox = oauthStatus.toRetry && (
        <Box marginTop={1}>
          <Text color="permission">{tSync('oauth.pressEnterToRetry')}</Text>
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1}>
          {errorMsg}
          {retryBox}
        </Box>
      )
    }
    default: {
      return null
    }
  }
}
