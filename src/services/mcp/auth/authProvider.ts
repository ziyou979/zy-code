import { type AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getSecureStorage } from '../../secure-storage/index.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from '../types.js'
import { getServerKey } from './oauthErrors.js'
export async function readClientSecret(): Promise<string> {
  const envSecret = process.env.MCP_CLIENT_SECRET
  if (envSecret) {
    return envSecret
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.',
    )
  }

  return new Promise((resolve, reject) => {
    process.stderr.write('Enter OAuth client secret: ')
    process.stdin.setRawMode?.(true)
    let secret = ''
    const onData = (ch: Buffer) => {
      const c = ch.toString()
      if (c === '\n' || c === '\r') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolve(secret)
      } else if (c === '\u0003') {
        process.stdin.setRawMode?.(false)
        process.stdin.removeListener('data', onData)
        reject(new Error('Cancelled'))
      } else if (c === '\u007F' || c === '\b') {
        secret = secret.slice(0, -1)
      } else {
        secret += c
      }
    }
    process.stdin.on('data', onData)
  })
}

export function saveMcpClientSecret(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  clientSecret: string,
): void {
  const storage = getSecureStorage()
  const existingData = storage.read() || {}
  const serverKey = getServerKey(serverName, serverConfig)
  storage.update({
    ...existingData,
    mcpOAuthClientConfig: {
      ...existingData.mcpOAuthClientConfig,
      [serverKey]: { clientSecret },
    },
  })
}

export function clearMcpClientConfig(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  const storage = getSecureStorage()
  const existingData = storage.read()
  if (!existingData?.mcpOAuthClientConfig) {
    return
  }
  const serverKey = getServerKey(serverName, serverConfig)
  if (existingData.mcpOAuthClientConfig[serverKey]) {
    delete existingData.mcpOAuthClientConfig[serverKey]
    storage.update(existingData)
  }
}

export function getMcpClientConfig(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): { clientSecret?: string } | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  const serverKey = getServerKey(serverName, serverConfig)
  return data?.mcpOAuthClientConfig?.[serverKey]
}

/**
 * 从 AuthorizationServerMetadata 中安全提取 scope 信息。metadata 可能是 OAuthMetadata 或
 * OpenIdProviderDiscoveryMetadata，不同 provider 使用不同字段保存 scope 信息。
 */
export function getScopeFromMetadata(
  metadata: AuthorizationServerMetadata | undefined,
): string | undefined {
  if (!metadata) {
    return undefined
  }
  // 先尝试 'scope'（非标准但某些提供者使用）
  if ('scope' in metadata && typeof metadata.scope === 'string') {
    return metadata.scope
  }
  // 尝试 'default_scope'（非标准但某些提供者使用）
  if ('default_scope' in metadata && typeof metadata.default_scope === 'string') {
    return metadata.default_scope
  }
  // 回退到 scopes_supported（标准 OAuth 2.0 字段）
  if (metadata.scopes_supported && Array.isArray(metadata.scopes_supported)) {
    return metadata.scopes_supported.join(' ')
  }
  return undefined
}
