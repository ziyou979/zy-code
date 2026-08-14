/**
 * OAuth redirect 端口辅助函数；从 auth.ts 提取，以打破 auth.ts ↔ xaaIdpLogin.ts 循环依赖。
 */
import { createServer } from 'node:http'
import { getPlatform } from '../shell/platform.js'

// 避开 Windows 保留的 49152-65535 动态端口范围
const REDIRECT_PORT_RANGE =
  getPlatform() === 'windows' ? { min: 39152, max: 49151 } : { min: 49152, max: 65535 }
const REDIRECT_PORT_FALLBACK = 3118

/**
 * 使用给定端口和固定 `/callback` 路径构造 localhost redirect URI。
 *
 * RFC 8252 第 7.3 节（原生应用 OAuth）规定：只要路径匹配，loopback redirect URI 可匹配
 * 任意端口。
 */
export function buildRedirectUri(port: number = REDIRECT_PORT_FALLBACK): string {
  return `http://localhost:${port}/callback`
}

function getMcpOAuthCallbackPort(): number | undefined {
  const port = parseInt(process.env.MCP_OAUTH_CALLBACK_PORT || '', 10)
  return port > 0 ? port : undefined
}

/**
 * 在指定范围内随机选择一个可用端口供 OAuth redirect 使用，以提高安全性。
 */
export async function findAvailablePort(): Promise<number> {
  // 若指定了配置端口，优先尝试该端口
  const configuredPort = getMcpOAuthCallbackPort()
  if (configuredPort) {
    return configuredPort
  }

  const { min, max } = REDIRECT_PORT_RANGE
  const range = max - min + 1
  const maxAttempts = Math.min(range, 100) // Don't try forever

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = min + Math.floor(Math.random() * range)

    try {
      await new Promise<void>((resolve, reject) => {
        const testServer = createServer()
        testServer.once('error', reject)
        testServer.listen(port, () => {
          testServer.close(() => resolve())
        })
      })
      return port
    } catch {}
  }

  // 随机选择失败时尝试后备端口
  try {
    await new Promise<void>((resolve, reject) => {
      const testServer = createServer()
      testServer.once('error', reject)
      testServer.listen(REDIRECT_PORT_FALLBACK, () => {
        testServer.close(() => resolve())
      })
    })
    return REDIRECT_PORT_FALLBACK
  } catch {
    throw new Error(`No available ports for OAuth redirect`)
  }
}
