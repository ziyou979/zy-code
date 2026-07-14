import { execa } from 'execa'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as SafeString,
} from '../../services/analytics/index.js'
import { getGhAuthStatus } from '../../services/github/ghAuthStatus.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { openBrowser } from '../../utils/browser.js'
import {
  createDefaultEnvironment,
  getCodeWebUrl,
  type ImportTokenError,
  importGithubToken,
  isSignedIn,
  RedactedGithubToken,
} from './api.js'

type CheckResult =
  | {
      status: 'not_signed_in'
    }
  | {
      status: 'has_gh_token'
      token: RedactedGithubToken
    }
  | {
      status: 'gh_not_installed'
    }
  | {
      status: 'gh_not_authenticated'
    }
async function checkLoginState(): Promise<CheckResult> {
  if (!(await isSignedIn())) {
    return {
      status: 'not_signed_in',
    }
  }
  const ghStatus = await getGhAuthStatus()
  if (ghStatus === 'not_installed') {
    return {
      status: 'gh_not_installed',
    }
  }
  if (ghStatus === 'not_authenticated') {
    return {
      status: 'gh_not_authenticated',
    }
  }

  // ghStatus === 'authenticated'. getGhAuthStatus spawns with stdout:'ignore'
  // (telemetry-safe); spawn once more with stdout:'pipe' to read the token.
  const { stdout } = await execa('gh', ['auth', 'token'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    reject: false,
  })
  const trimmed = stdout.trim()
  if (!trimmed) {
    return {
      status: 'gh_not_authenticated',
    }
  }
  return {
    status: 'has_gh_token',
    token: new RedactedGithubToken(trimmed),
  }
}
function errorMessage(err: ImportTokenError, codeUrl: string): string {
  switch (err.kind) {
    case 'not_signed_in':
      return tSync('remoteSetup.loginFailed', { url: codeUrl })
    case 'invalid_token':
      return tSync('remoteSetup.invalidToken')
    case 'server':
      return tSync('remoteSetup.serverError', { status: err.status })
    case 'network':
      return tSync('remoteSetup.networkError')
  }
}
type Step =
  | {
      name: 'checking'
    }
  | {
      name: 'confirm'
      token: RedactedGithubToken
    }
  | {
      name: 'uploading'
    }
function Web({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [step, setStep] = useState<Step>({
    name: 'checking',
  })
  useEffect(() => {
    logEvent('zy_remote_setup_started', {})
    void checkLoginState().then(async (result) => {
      switch (result.status) {
        case 'not_signed_in':
          logEvent('zy_remote_setup_result', {
            result: 'not_signed_in' as SafeString,
          })
          onDone(tSync('remoteSetup.notSignedIn'))
          return
        case 'gh_not_installed':
        case 'gh_not_authenticated': {
          const url = `${getCodeWebUrl()}/onboarding?step=alt-auth`
          await openBrowser(url)
          logEvent('zy_remote_setup_result', {
            result: result.status as SafeString,
          })
          onDone(
            result.status === 'gh_not_installed'
              ? tSync('remoteSetup.ghNotInstalled', { url })
              : tSync('remoteSetup.ghNotAuthenticated', { url }),
          )
          return
        }
        case 'has_gh_token':
          setStep({
            name: 'confirm',
            token: result.token,
          })
      }
    })
    // onDone is stable across renders; intentionally not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDone])
  const handleCancel = () => {
    logEvent('zy_remote_setup_result', {
      result: 'cancelled' as SafeString,
    })
    onDone()
  }
  const handleConfirm = async (token: RedactedGithubToken) => {
    setStep({
      name: 'uploading',
    })
    const result = await importGithubToken(token)
    if (!result.ok) {
      logEvent('zy_remote_setup_result', {
        result: 'import_failed' as SafeString,
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        error_kind: (result as any).error.kind as SafeString,
      })
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      onDone(errorMessage((result as any).error, getCodeWebUrl()))
      return
    }

    // Token import succeeded. Environment creation is best-effort — if it
    // fails, the web state machine routes to env-setup on landing, which is
    // one extra click but still better than the OAuth dance.
    await createDefaultEnvironment()
    const url = getCodeWebUrl()
    await openBrowser(url)
    logEvent('zy_remote_setup_result', {
      result: 'success' as SafeString,
    })
    onDone(`Connected as ${result.result.github_username}. Opened ${url}`)
  }
  if (step.name === 'checking') {
    return <LoadingState message={tSync('remoteSetup.checkingLogin')} />
  }
  if (step.name === 'uploading') {
    return <LoadingState message={tSync('remoteSetup.connectingGithub')} />
  }
  const token = step.token
  return (
    <Dialog title={tSync('remoteSetup.dialogTitle')} onCancel={handleCancel} hideInputGuide>
      <Box flexDirection="column">
        <Text>{tSync('remoteSetup.dialogDescription')}</Text>
        <Text dimColor>{tSync('remoteSetup.dialogNote')}</Text>
      </Box>
      <Select
        options={[
          {
            label: tSync('remoteSetup.continue'),
            value: 'send',
          },
          {
            label: tSync('remoteSetup.cancel'),
            value: 'cancel',
          },
        ]}
        onChange={(value: string) => {
          if (value === 'send') {
            void handleConfirm(token)
          } else {
            handleCancel()
          }
        }}
        onCancel={handleCancel}
      />
    </Dialog>
  )
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <Web onDone={onDone} />
}
