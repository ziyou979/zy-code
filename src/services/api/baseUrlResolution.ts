import type { ApiFormat } from '../model/apiFormat.js'
import {
  resolveModelRequestContext,
  type ModelRequestContext,
} from '../model/modelRequestContext.js'
import {
  getDefaultBaseUrl,
  getDefaultBaseUrlForFormat,
  getProviderEntry,
} from '../model/providerRegistry.js'
import type { ProviderEntry } from '../model/providerRegistry.js'
import { getSettingsBaseUrl } from '../model/providers.js'
import { getAuthConfigApiFormat, getAuthConfigBaseUrl } from '../auth/authConfig.js'
import { isInternalBuild } from '../infra/envUtils.js'

type FormatAwareBaseUrlOptions = {
  configuredBaseUrl?: string
  configuredFormat?: ApiFormat
  targetFormat: ApiFormat
  entry?: ProviderEntry
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * 当命名连接保存的是某协议的内置默认 URL，而模型级配置切换了协议时，
 * 同步切换到目标协议的内置端点。真正的自定义 URL 始终原样保留。
 */
export function resolveFormatAwareBaseUrl({
  configuredBaseUrl,
  configuredFormat,
  targetFormat,
  entry,
}: FormatAwareBaseUrlOptions): string | undefined {
  if (!configuredBaseUrl || !configuredFormat || configuredFormat === targetFormat) {
    return configuredBaseUrl
  }

  const configuredFormatDefault = entry ? getDefaultBaseUrl(entry, configuredFormat) : undefined
  const targetFormatDefault = entry ? getDefaultBaseUrl(entry, targetFormat) : undefined
  if (
    !configuredFormatDefault ||
    !targetFormatDefault ||
    trimTrailingSlashes(configuredBaseUrl) !== trimTrailingSlashes(configuredFormatDefault)
  ) {
    return configuredBaseUrl
  }

  return targetFormatDefault
}

type ResolveApiBaseUrlOptions = {
  context: ModelRequestContext
  explicitBaseUrl?: string
  env?: NodeJS.ProcessEnv
}

/**
 * 按统一优先级解析请求最终使用的 API 端点。
 * SDK 官方默认端点返回 undefined，由对应 SDK 使用自身默认值。
 */
export function resolveApiBaseUrl({
  context,
  explicitBaseUrl,
  env = process.env,
}: ResolveApiBaseUrlOptions): string | undefined {
  if (explicitBaseUrl) {
    return explicitBaseUrl
  }

  const entry = getProviderEntry(context.provider)
  const providerEnvUrl = entry?.baseUrlEnvVar ? env[entry.baseUrlEnvVar] : undefined
  if (providerEnvUrl) {
    return providerEnvUrl
  }

  const formatEnvUrl =
    context.apiFormat === 'anthropic'
      ? env.ZY_CODE_BASE_URL
      : context.apiFormat === 'google'
        ? env.GOOGLE_BASE_URL
        : env.OPENAI_BASE_URL
  if (formatEnvUrl) {
    return formatEnvUrl
  }
  if (env.LLM_BASE_URL) {
    return env.LLM_BASE_URL
  }

  const configuredBaseUrl = resolveFormatAwareBaseUrl({
    configuredBaseUrl: getAuthConfigBaseUrl(context.authProfile),
    configuredFormat: getAuthConfigApiFormat(context.authProfile),
    targetFormat: context.apiFormat,
    entry,
  })
  if (configuredBaseUrl) {
    return configuredBaseUrl
  }

  const settingsBaseUrl = getSettingsBaseUrl(context.provider)
  if (settingsBaseUrl) {
    return settingsBaseUrl
  }

  return entry ? getDefaultBaseUrlForFormat(entry, context.apiFormat) : undefined
}

/** 判断已解析端点是否为 Anthropic 官方 API；undefined 表示 SDK 官方默认端点。 */
export function isOfficialAnthropicApiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return true
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return (
      hostname === 'api.anthropic.com' ||
      (isInternalBuild() && hostname === 'api-staging.anthropic.com')
    )
  } catch {
    return false
  }
}

/** 基于已解析请求上下文判断是否直连 Anthropic 官方端点。 */
export function isAnthropicOfficialEndpoint(context: ModelRequestContext): boolean {
  if (context.apiFormat !== 'anthropic') {
    return false
  }
  const baseUrl = resolveApiBaseUrl({ context })
  return baseUrl ? isOfficialAnthropicApiBaseUrl(baseUrl) : context.provider === 'anthropic'
}

/** 基于当前模型的完整路由配置判断是否直连 Anthropic 官方端点。 */
export function isAnthropicOfficialEndpointForModel(model?: string | null): boolean {
  return isAnthropicOfficialEndpoint(resolveModelRequestContext(model))
}
