/* eslint-disable custom-rules/no-process-exit -- CLI 子命令处理器有意退出 */

import { performLogout } from '../../commands/logout/logout.js'
import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { getAPIProvider } from '../../services/model/providers.js'
import {
  clearOAuthCredentialsCache,
  getActiveOAuthProvider,
  getActiveOAuthProviderInfo,
  saveOAuthCredentials,
} from '../../services/oauth/oauthStorage.js'
import { getOAuthProvider, getOAuthProviders } from '../../services/oauth/providers/index.js'
import type { OAuthCredentials, OAuthLoginCallbacks } from '../../services/oauth/providers/types.js'
import { getApiKeyWithSource, getAuthTokenSource } from '../../services/auth/auth.js'
import { openBrowser } from '../../services/browser/browser.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { buildAccountProperties, buildAPIProviderProperties } from '../../utils/status.js'

/**
 * 使用多 Provider OAuth 流程登录（CLI 版本）。
 * 通过控制台 I/O 实现 OAuthLoginCallbacks。
 */
async function authLoginWithProvider(providerId: string): Promise<void> {
  const provider = getOAuthProvider(providerId)
  if (!provider) {
    const available = getOAuthProviders()
      .map((p) => p.id)
      .join(', ')
    process.stderr.write(`Unknown provider: ${providerId}\nAvailable providers: ${available}\n`)
    process.exit(1)
  }

  const readline = await import('node:readline/promises')
  const { stdin, stdout } = process
  const rl = readline.createInterface({ input: stdin, output: stdout })

  try {
    logEvent('zy_oauth_provider_login_start', {
      providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    process.stdout.write(`Logging in with ${provider.name}...\n`)

    const callbacks: OAuthLoginCallbacks = {
      onAuth: async (info) => {
        process.stdout.write(`\n${tSync('oauth.openingBrowserToSignIn')}\n`)
        process.stdout.write(`${info.url}\n`)
        await openBrowser(info.url)
      },
      onDeviceCode: async (info) => {
        process.stdout.write(`\n${tSync('oauth.deviceCodeUserCode', { code: info.userCode })}\n`)
        process.stdout.write(`${tSync('oauth.deviceCodeVisit', { url: info.verificationUri })}\n`)
        await openBrowser(info.verificationUri)
      },
      onPrompt: async (prompt) => {
        const answer = await rl.question(
          `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''} `,
        )
        return answer
      },
      onManualCodeInput: async () => {
        const answer = await rl.question('Paste the authorization code: ')
        return answer
      },
      onSelect: async (prompt) => {
        process.stdout.write(`\n${prompt.message}\n`)
        prompt.options.forEach((opt, i) => {
          process.stdout.write(`  ${i + 1}. ${opt.label}\n`)
        })
        const answer = await rl.question(`${tSync('oauth.selectProvider')} `)
        const idx = parseInt(answer, 10) - 1
        if (idx >= 0 && idx < prompt.options.length) {
          return prompt.options[idx].id
        }
        return prompt.options[0]?.id ?? ''
      },
      onProgress: (message) => {
        process.stdout.write(`${message}\n`)
      },
    }

    const credentials: OAuthCredentials = await provider.login(callbacks)

    // 保存凭证
    await saveOAuthCredentials(provider.id, credentials)
    clearOAuthCredentialsCache()

    logEvent('zy_oauth_provider_login_success', {
      providerId: providerId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    process.stdout.write(`${tSync('auth.login.successful')}\n`)
    process.exit(0)
  } catch (err) {
    logError(err)
    const sslHint = getSSLErrorHint(err)
    process.stderr.write(
      tSync('auth.login.failed', { error: errorMessage(err) }) +
        '\n' +
        (sslHint ? `${sslHint}\n` : ''),
    )
    process.exit(1)
  } finally {
    rl.close()
  }
}

export async function authLogin({ provider }: { provider?: string } = {}): Promise<void> {
  if (!provider) {
    // 未指定 provider，列出可用 provider
    const providers = getOAuthProviders()
    process.stderr.write('Available providers:\n')
    for (const p of providers) {
      process.stderr.write(`  ${p.id} - ${p.name}\n`)
    }
    process.stderr.write('\nUsage: zy auth login --provider <provider>\n')
    process.exit(1)
  }

  return authLoginWithProvider(provider)
}

export async function authStatus(opts: { json?: boolean; text?: boolean }): Promise<void> {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getApiKeyWithSource()
  const hasApiKeyEnvVar = !!process.env.ZY_API_KEY && !isRunningOnHomespace()
  const loggedIn = hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar

  // 检查多 Provider OAuth
  const activeOAuthProvider = getActiveOAuthProvider()
  const activeOAuthProviderInfo = getActiveOAuthProviderInfo()

  // 确定认证方式
  let authMethod: string = 'none'
  if (activeOAuthProvider) {
    authMethod = `oauth:${activeOAuthProvider}`
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'settingsApiKey' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === 'oauth') {
    authMethod = 'oauth'
  }

  if (opts.text) {
    const properties = [...buildAccountProperties(), ...buildAPIProviderProperties()]
    let hasAuthProperty = false
    for (const prop of properties) {
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    if (!hasAuthProperty && hasApiKeyEnvVar) {
      process.stdout.write(`${tSync('auth.status.apiKeyEnvVar')}\n`)
    }
    if (!loggedIn) {
      process.stdout.write(`${tSync('auth.status.notLoggedIn')}\n`)
    }
  } else {
    const apiProvider = getAPIProvider()
    const resolvedApiKeySource =
      apiKeySource !== 'none' ? apiKeySource : hasApiKeyEnvVar ? 'settingsApiKey' : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    if (activeOAuthProvider) {
      output.oauthProvider = activeOAuthProvider
      output.oauthProviderName = activeOAuthProviderInfo?.name ?? null
    }

    process.stdout.write(`${jsonStringify(output, null, 2)}\n`)
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write(`${tSync('auth.logout.failed')}\n`)
    process.exit(1)
  }
  process.stdout.write(`${tSync('auth.logout.successful')}\n`)
  process.exit(0)
}
