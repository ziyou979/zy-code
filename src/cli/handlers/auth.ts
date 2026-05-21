/* eslint-disable custom-rules/no-process-exit -- CLI 子命令处理器有意退出 */

import { clearAuthRelatedCaches, performLogout } from '../../commands/logout/logout.js'
import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { fetchAndStoreZyCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  refreshOAuthToken,
  shouldUseZyAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { OAuthService } from '../../services/oauth/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  clearOAuthTokenCache,
  getApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { buildAccountProperties, buildAPIProviderProperties } from '../../utils/status.js'

/**
 * 获取令牌后的共享逻辑。保存令牌、获取用户资料/角色，
 * 并设置本地认证状态。
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // 在保存新凭据前清除旧状态
  await performLogout({ clearOnboarding: false })

  // 如果有预获取的用户资料则复用，否则重新获取
  const profile =
    (tokens as any).profile ?? (await getOauthProfileFromOauthToken(tokens.accessToken))
  if (profile) {
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled: profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt: profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if ((tokens as any).tokenAccount) {
    // 当用户资料端点失败时，回退使用令牌交换的账户数据
    storeOAuthAccountInfo({
      accountUuid: (tokens as any).tokenAccount.uuid,
      emailAddress: (tokens as any).tokenAccount.emailAddress,
      organizationUuid: (tokens as any).tokenAccount.organizationUuid,
    })
  }

  const storageResult = saveOAuthTokensIfNeeded(tokens)
  clearOAuthTokenCache()

  if (storageResult.warning) {
    logEvent('zy_oauth_storage_warning', {
      warning: storageResult.warning as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 角色和首次令牌日期对于有限范围的令牌可能会失败（例如仅推理用途的 setup-token）。
  // 它们不是核心认证所必需的。
  await fetchAndStoreUserRoles(tokens.accessToken).catch((err) =>
    logForDebugging(String(err), { level: 'error' }),
  )

  if (shouldUseZyAIAuth((tokens as any).scopes)) {
    await fetchAndStoreZyCodeFirstTokenDate().catch((err) =>
      logForDebugging(String(err), { level: 'error' }),
    )
  } else {
    // API 密钥创建对控制台用户至关重要——允许抛出异常。
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(tSync('auth.installOAuth.apiKeyCreationFailed'))
    }
  }

  await clearAuthRelatedCaches()
}

export async function authLogin({
  email,
  sso,
  console: useConsole,
  zyai,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  zyai?: boolean
}): Promise<void> {
  if (useConsole && zyai) {
    process.stderr.write(`${tSync('auth.login.consoleZyaiMutualExclusive')}\n`)
    process.exit(1)
  }

  const settings = getInitialSettings()
  // forceLoginMethod 是硬性约束（企业设置）——与 ConsoleOAuthFlow 行为一致。
  // 若未设置，--console 选择控制台；--zyai（或无标志）选择 zy.ai。
  const loginWithZyAi = settings.forceLoginMethod
    ? settings.forceLoginMethod === 'zyai'
    : !useConsole
  const orgUUID = settings.forceLoginOrgUUID

  // 快速路径：如果通过环境变量提供了刷新令牌，则跳过浏览器
  // OAuth 流程，直接用刷新令牌换取访问令牌。
  const envRefreshToken = process.env.ZY_CODE_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const envScopes = process.env.ZY_CODE_OAUTH_SCOPES
    if (!envScopes) {
      process.stderr.write(`${tSync('auth.login.scopesRequired')}\n`)
      process.exit(1)
    }

    const scopes = envScopes.split(/\s+/).filter(Boolean)

    try {
      logEvent('zy_login_from_refresh_token', {})

      const tokens = await refreshOAuthToken(envRefreshToken, { scopes })
      await installOAuthTokens(tokens)

      const orgResult = await validateForceLoginOrg()
      if (!(orgResult as any).valid) {
        process.stderr.write(`${(orgResult as any).message}\n`)
        process.exit(1)
      }

      // 标记引导完成——交互式路径通过 Onboarding 组件处理此步骤，
      // 但环境变量路径跳过了该组件。
      saveGlobalConfig((current) => {
        if (current.hasCompletedOnboarding) {
          return current
        }
        return { ...current, hasCompletedOnboarding: true }
      })

      logEvent('zy_oauth_success', {
        loginWithZyAi: shouldUseZyAIAuth((tokens as any).scopes),
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
    }
  }

  const resolvedLoginMethod = sso ? 'sso' : undefined

  const oauthService = new OAuthService()

  try {
    logEvent('zy_oauth_flow_start', { loginWithZyAi })

    const result = await oauthService.startOAuthFlow(
      async (url) => {
        process.stdout.write(`${tSync('auth.login.openingBrowser')}\n`)
        process.stdout.write(`${tSync('auth.login.visitUrl', { url })}\n`)
      },
      {
        loginWithZyAi,
        loginHint: email,
        loginMethod: resolvedLoginMethod,
        orgUUID,
      },
    )

    await installOAuthTokens(result)

    const orgResult = await validateForceLoginOrg()
    if (!(orgResult as any).valid) {
      process.stderr.write(`${(orgResult as any).message}\n`)
      process.exit(1)
    }

    logEvent('zy_oauth_success', { loginWithZyAi })

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
    oauthService.cleanup()
  }
}

export async function authStatus(opts: { json?: boolean; text?: boolean }): Promise<void> {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getApiKeyWithSource()
  const hasApiKeyEnvVar = !!process.env.ZY_API_KEY && !isRunningOnHomespace()
  const oauthAccount = getOauthAccountInfo()
  const using3P = false
  const loggedIn = hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar || using3P

  // 确定认证方式
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (authTokenSource === 'zy.ai') {
    authMethod = 'zy.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'settingsApiKey' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'zy.ai'
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
    if (authMethod === 'zy.ai') {
      output.email = oauthAccount?.emailAddress ?? null
      output.orgId = oauthAccount?.organizationUuid ?? null
      output.orgName = oauthAccount?.organizationName ?? null
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
