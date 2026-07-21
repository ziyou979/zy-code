/**
 * 用户级认证配置读取。
 *
 * auth.json 只承载敏感认证材料；settings.json 继续承载 provider/model/baseUrl
 * 等普通配置。顶层 key 就是 provider id，不再包含 providers 包装层。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'

const AuthProviderConfigSchema = z
  .object({
    apiKey: z.string().optional().describe('Provider-scoped API key.'),
    apiKeyHelper: z.string().optional().describe('Provider-scoped command that prints an API key.'),
  })
  .passthrough()

const AuthConfigSchema = z
  .record(z.string(), AuthProviderConfigSchema)
  .refine((config) => !Object.hasOwn(config, 'providers'), {
    message: 'auth.json uses provider ids at the top level.',
  })
  .describe('Provider-scoped authentication configuration keyed by provider id.')

export type AuthProviderConfig = z.infer<typeof AuthProviderConfigSchema>
export type AuthConfig = z.infer<typeof AuthConfigSchema>

export function getAuthConfigPath(): string {
  return join(getZyConfigHomeDir(), 'auth.json')
}

export function parseAuthConfig(value: unknown): AuthConfig | null {
  const result = AuthConfigSchema.safeParse(value)
  return result.success ? result.data : null
}

export function loadAuthConfigFromPath(path: string): AuthConfig | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return parseAuthConfig(safeParseJSON(raw, false))
  } catch {
    return null
  }
}

export function loadAuthConfig(): AuthConfig | null {
  return loadAuthConfigFromPath(getAuthConfigPath())
}

export function getAuthConfigForProviderFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): AuthProviderConfig | undefined {
  if (!provider) {
    return undefined
  }
  return config?.[provider]
}

export function getAuthConfigForProvider(provider?: string | null): AuthProviderConfig | undefined {
  return getAuthConfigForProviderFromConfig(loadAuthConfig(), provider)
}

export function getAuthConfigApiKeyFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): string | undefined {
  return getAuthConfigForProviderFromConfig(config, provider)?.apiKey
}

export function getAuthConfigApiKey(provider?: string | null): string | undefined {
  const config = loadAuthConfig()
  return getAuthConfigApiKeyFromConfig(config, provider)
}

export function getAuthConfigApiKeyHelperFromConfig(
  config: AuthConfig | null,
  provider?: string | null,
): string | undefined {
  return getAuthConfigForProviderFromConfig(config, provider)?.apiKeyHelper
}

export function getAuthConfigApiKeyHelper(provider?: string | null): string | undefined {
  const config = loadAuthConfig()
  return getAuthConfigApiKeyHelperFromConfig(config, provider)
}
