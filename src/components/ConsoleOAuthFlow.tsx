import React, { useCallback, useEffect, useRef, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { setClipboard } from '../ink/termio/osc.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { Box, Link, Text } from '../ink/index.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getSSLErrorHint } from '../services/api/errorUtils.js'
import { sendNotification } from '../services/notifier.js'
import { saveOAuthCredentials } from '../services/oauth/oauthStorage.js'
import { getOAuthProviders } from '../services/oauth/providers/index.js'
import type {
  OAuthLoginCallbacks,
  OAuthProviderInterface,
  OAuthSelectOption,
} from '../services/oauth/providers/types.js'
import { openBrowser } from '../services/browser/browser.js'
import { logError } from '../services/infra/log.js'
import { Select } from './CustomSelect/select.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

// ─── 登录流程状态 ───────────────────────────────────────────────────────────

type OAuthStatus =
  | { state: 'idle' }
  | { state: 'platform_setup' }
  | { state: 'waiting_for_login'; url: string }
  | { state: 'device_code_waiting'; userCode: string; verificationUri: string }
  | { state: 'select_login_method'; options: OAuthSelectOption[]; message: string }
  | { state: 'prompt_input'; message: string; placeholder?: string }
  | { state: 'progress'; message: string }
  | { state: 'about_to_retry'; nextState: OAuthStatus }
  | { state: 'success'; providerName: string }
  | { state: 'error'; message: string; toRetry?: OAuthStatus }

const PASTE_HERE_MSG = 'Paste code here if prompted > '

export function ConsoleOAuthFlow({ onDone, startingMessage }: Props): React.ReactNode {
  const terminal = useTerminalNotification()
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>({ state: 'idle' })
  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [showPastePrompt, setShowPastePrompt] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1

  // 多 Provider 回调的 Promise resolver refs
  const promptResolverRef = useRef<((value: string) => void) | null>(null)
  const manualCodeResolverRef = useRef<((value: string) => void) | null>(null)
  const selectResolverRef = useRef<((value: string | undefined) => void) | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // 可用的 OAuth Provider 列表
  const oauthProviders = getOAuthProviders()

  // 重试逻辑
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(setOAuthStatus, 1000, oauthStatus.nextState)
      return () => clearTimeout(timer)
    }
  }, [oauthStatus])

  // 成功时按 Enter 继续
  useKeybinding(
    'confirm:yes',
    () => {
      onDone()
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'success',
    },
  )

  // 平台设置页按 Enter 返回
  useKeybinding(
    'confirm:yes',
    () => {
      setOAuthStatus({ state: 'idle' })
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'platform_setup',
    },
  )

  // 错误时按 Enter 重试
  useKeybinding(
    'confirm:yes',
    () => {
      if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
        setPastedCode('')
        setOAuthStatus({ state: 'about_to_retry', nextState: oauthStatus.toRetry })
      }
    },
    {
      context: 'Confirmation',
      isActive: oauthStatus.state === 'error' && !!oauthStatus.toRetry,
    },
  )

  // URL 复制快捷键
  useEffect(() => {
    if (
      pastedCode === 'c' &&
      oauthStatus.state === 'waiting_for_login' &&
      showPastePrompt &&
      !urlCopied
    ) {
      void setClipboard(oauthStatus.url).then((raw) => {
        if (raw) {
          process.stdout.write(raw)
        }
        setUrlCopied(true)
        setTimeout(setUrlCopied, 2000, false)
      })
      setPastedCode('')
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied])

  // ─── 手动代码提交 ──────────────────────────────────────────────────────
  async function handleSubmitCode(value: string, url: string) {
    try {
      logEvent('zy_oauth_manual_entry', {})

      // 通过 resolver 返回手动输入
      if (manualCodeResolverRef.current) {
        manualCodeResolverRef.current(value)
        manualCodeResolverRef.current = null
        return
      }

      setOAuthStatus({
        state: 'error',
        message: tSync('oauth.invalidCode'),
        toRetry: { state: 'waiting_for_login', url },
      })
    } catch (err: unknown) {
      logError(err)
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: { state: 'waiting_for_login', url },
      })
    }
  }

  // ─── 多 Provider OAuth 登录流程 ──────────────────────────────────────────
  const startMultiProviderLogin = useCallback(
    async (provider: OAuthProviderInterface) => {
      abortControllerRef.current = new AbortController()

      const callbacks: OAuthLoginCallbacks = {
        onAuth: (info) => {
          setOAuthStatus({ state: 'waiting_for_login', url: info.url })
          void openBrowser(info.url)
          setTimeout(setShowPastePrompt, 3000, true)
        },
        onDeviceCode: (info) => {
          setOAuthStatus({
            state: 'device_code_waiting',
            userCode: info.userCode,
            verificationUri: info.verificationUri,
          })
          void openBrowser(info.verificationUri)
        },
        onPrompt: (prompt) => {
          return new Promise<string>((resolve) => {
            promptResolverRef.current = resolve
            setOAuthStatus({
              state: 'prompt_input',
              message: prompt.message,
              placeholder: prompt.placeholder,
            })
          })
        },
        onProgress: (message) => {
          setOAuthStatus({ state: 'progress', message })
        },
        onManualCodeInput: () => {
          return new Promise<string>((resolve) => {
            manualCodeResolverRef.current = resolve
          })
        },
        onSelect: (prompt) => {
          return new Promise<string | undefined>((resolve) => {
            selectResolverRef.current = resolve
            setOAuthStatus({
              state: 'select_login_method',
              options: prompt.options,
              message: prompt.message,
            })
          })
        },
        signal: abortControllerRef.current.signal,
      }

      try {
        logEvent('zy_oauth_multi_provider_login_start', {
          providerId: provider.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        const credentials = await provider.login(callbacks)

        // 保存凭证
        const saveResult = saveOAuthCredentials(provider.id, credentials)
        if (!saveResult.success) {
          logEvent('zy_oauth_multi_provider_save_failed', {
            providerId: provider.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        }

        logEvent('zy_oauth_multi_provider_login_success', {
          providerId: provider.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        setOAuthStatus({ state: 'success', providerName: provider.name })
        void sendNotification(
          { message: 'ZY Code login successful', notificationType: 'auth_success' },
          terminal,
        )
      } catch (err) {
        const errorMessage = (err as Error).message
        const sslHint = getSSLErrorHint(err)
        setOAuthStatus({
          state: 'error',
          message: sslHint ?? errorMessage,
          toRetry: { state: 'idle' },
        })
        logEvent('zy_oauth_multi_provider_login_error', {
          providerId: provider.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ssl_error: sslHint !== null,
        })
      } finally {
        promptResolverRef.current = null
        manualCodeResolverRef.current = null
        selectResolverRef.current = null
        abortControllerRef.current = null
        setShowPastePrompt(false)
      }
    },
    [terminal],
  )

  // 清理
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  // ─── prompt_input 状态的文本提交 ──────────────────────────────────────
  function handlePromptSubmit(value: string) {
    if (promptResolverRef.current) {
      promptResolverRef.current(value)
      promptResolverRef.current = null
    }
  }

  // ─── select_login_method 状态的选择处理 ──────────────────────────────
  function handleSelectMethod(value: string) {
    if (selectResolverRef.current) {
      selectResolverRef.current(value)
      selectResolverRef.current = null
    }
  }

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
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <OAuthStatusMessage
          oauthStatus={oauthStatus}
          startingMessage={startingMessage}
          showPastePrompt={showPastePrompt}
          pastedCode={pastedCode}
          setPastedCode={setPastedCode}
          cursorOffset={cursorOffset}
          setCursorOffset={setCursorOffset}
          textInputColumns={textInputColumns}
          handleSubmitCode={handleSubmitCode}
          setOAuthStatus={setOAuthStatus}
          oauthProviders={oauthProviders}
          onSelectProvider={startMultiProviderLogin}
          onPromptSubmit={handlePromptSubmit}
          onSelectMethod={handleSelectMethod}
        />
      </Box>
    </Box>
  )
}

// ─── 状态渲染组件 ─────────────────────────────────────────────────────────

type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus
  startingMessage: string | undefined
  showPastePrompt: boolean
  pastedCode: string
  setPastedCode: (value: string) => void
  cursorOffset: number
  setCursorOffset: (offset: number) => void
  textInputColumns: number
  handleSubmitCode: (value: string, url: string) => void
  setOAuthStatus: (status: OAuthStatus) => void
  oauthProviders: OAuthProviderInterface[]
  onSelectProvider: (provider: OAuthProviderInterface) => void
  onPromptSubmit: (value: string) => void
  onSelectMethod: (value: string) => void
}

function OAuthStatusMessage({
  oauthStatus,
  startingMessage,
  showPastePrompt,
  pastedCode,
  setPastedCode,
  cursorOffset,
  setCursorOffset,
  textInputColumns,
  handleSubmitCode,
  setOAuthStatus,
  oauthProviders,
  onSelectProvider,
  onPromptSubmit,
  onSelectMethod,
}: OAuthStatusMessageProps) {
  switch (oauthStatus.state) {
    case 'idle': {
      const message = startingMessage ?? tSync('oauth.selectProvider')
      const heading = <Text bold={true}>{message}</Text>

      const providerOptions = oauthProviders.map((provider) => ({
        label: (
          <Text>
            {provider.name}
            {'\n'}
          </Text>
        ),
        value: `oauth:${provider.id}`,
      }))

      const options = [
        ...providerOptions,
        {
          label: (
            <Text>
              {tSync('oauth.providerApikey')}{' '}
              <Text dimColor={true}>{tSync('oauth.providerApikeyDesc')}</Text>
              {'\n'}
            </Text>
          ),
          value: 'apikey',
        },
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

      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {heading}
          <Box>
            <Select
              options={options}
              onChange={(value: string) => {
                if (value === 'platform') {
                  logEvent('zy_oauth_platform_selected', {})
                  setOAuthStatus({ state: 'platform_setup' })
                } else if (value === 'apikey') {
                  logEvent('zy_oauth_apikey_selected', {})
                  setOAuthStatus({ state: 'platform_setup' })
                } else if (value.startsWith('oauth:')) {
                  const providerId = value.slice(6)
                  const provider = oauthProviders.find((p) => p.id === providerId)
                  if (provider) {
                    logEvent('zy_oauth_provider_selected', {
                      providerId:
                        provider.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    onSelectProvider(provider)
                  }
                }
              }}
            />
          </Box>
        </Box>
      )
    }
    case 'platform_setup': {
      const heading = <Text bold={true}>{tSync('oauth.usingThirdPartyPlatforms')}</Text>
      const description1 = <Text>{tSync('oauth.thirdPartyPlatformsDesc')}</Text>
      const description2 = <Text>{tSync('oauth.thirdPartyPlatformsEnterpriseHint')}</Text>
      const docHeading = <Text bold={true}>{tSync('oauth.documentation')}</Text>
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          {heading}
          <Box flexDirection="column" gap={1}>
            {description1}
            {description2}
            <Box flexDirection="column" marginTop={1}>
              {docHeading}
              <Text>
                · {tSync('oauth.bedrockLabel')}:{' '}
                <Link url="https://code.zy.com/docs/en/amazon-bedrock">
                  https://code.zy.com/docs/en/amazon-bedrock
                </Link>
              </Text>
              <Text>
                · {tSync('oauth.azureLabel')}:{' '}
                <Link url="https://code.zy.com/docs/en/microsoft-azure">
                  https://code.zy.com/docs/en/microsoft-azure
                </Link>
              </Text>
              <Text>
                · {tSync('oauth.vertexLabel')}:{' '}
                <Link url="https://code.zy.com/docs/en/google-vertex-ai">
                  https://code.zy.com/docs/en/google-vertex-ai
                </Link>
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor={true}>{tSync('oauth.pressEnterToGoBack')}</Text>
            </Box>
          </Box>
        </Box>
      )
    }
    case 'waiting_for_login': {
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
          {openingBrowserBox}
          {pasteInputBox}
        </Box>
      )
    }
    case 'device_code_waiting': {
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>{tSync('oauth.deviceCodeWaiting')}</Text>
          </Box>
          <Box flexDirection="column" gap={1} paddingLeft={1}>
            <Text bold={true}>
              {tSync('oauth.deviceCodeUserCode', { code: oauthStatus.userCode })}
            </Text>
            <Text dimColor>
              {tSync('oauth.deviceCodeVisit', { url: oauthStatus.verificationUri })}
            </Text>
          </Box>
        </Box>
      )
    }
    case 'select_login_method': {
      const options = oauthStatus.options.map((opt) => ({
        label: (
          <Text>
            {opt.label}
            {'\n'}
          </Text>
        ),
        value: opt.id,
      }))
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold={true}>{oauthStatus.message}</Text>
          <Box>
            <Select
              options={options}
              onChange={(value: string) => {
                onSelectMethod(value)
              }}
            />
          </Box>
        </Box>
      )
    }
    case 'prompt_input': {
      return (
        <Box flexDirection="column" gap={1} marginTop={1}>
          <Text bold={true}>{oauthStatus.message}</Text>
          <Box>
            <TextInput
              value={pastedCode}
              onChange={setPastedCode}
              onSubmit={onPromptSubmit}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={textInputColumns}
            />
          </Box>
        </Box>
      )
    }
    case 'progress': {
      return (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>{oauthStatus.message}</Text>
          </Box>
        </Box>
      )
    }
    case 'about_to_retry':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="permission">{tSync('oauth.retrying')}</Text>
        </Box>
      )
    case 'success': {
      return (
        <Box flexDirection="column">
          <Text dimColor={true}>
            {tSync('oauth.loggedInAs')} <Text>{oauthStatus.providerName}</Text>
          </Text>
          <Text color="success">{tSync('oauth.loginSuccessful')}</Text>
        </Box>
      )
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
