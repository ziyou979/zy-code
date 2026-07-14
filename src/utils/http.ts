/**
 * HTTP 工具常量和辅助函数
 */

import axios from 'axios'
import {
  getAPIProvider,
  isAnthropicProvider,
  isOpenAIProvider,
} from 'src/services/model/providers.js'
import { getApiKey, getZyAIOAuthTokens, handleOAuth401Error } from '../services/auth/auth.js'
import { getZyCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// 警告：我们依赖 user agent 中的 `zy-cli` 进行日志过滤。
// 请勿在未确认日志也更新的情况下修改此处！
export function getUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  // SDK 使用者可以通过 CLAUDE_AGENT_SDK_CLIENT_APP 标识其应用/库
  // 例如 "my-app/1.0.0" 或 "my-library/2.1"
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  // 轮次/进程范围的工作负载标签，用于 cron 发起的请求。仅直连 API 可观测性——
  // 代理会剥离 HTTP headers；QoS 路由使用计费 header 归因块中的 cc_workload
  // （见 constants/system.ts）。
  // getAnthropicClient (client.ts:98) 在 withRetry 内每次请求调用此方法，
  // 因此读取会获取与 getAttributionHeader 相同的 setWorkload() 值。
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `zy-cli/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.ZY_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.ZY_CODE_ENTRYPOINT) {
    parts.push(process.env.ZY_CODE_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `zy-code/${MACRO.VERSION}${suffix}`
}

// WebFetch 请求到任意站点的 User-Agent。`Zy-User` 是我们公开文档中
// 用于用户发起请求的 agent（运营者在 robots.txt 中匹配）；
// zy-code 后缀用于区分本地 CLI 流量和 zy.ai 服务端请求。
export function getWebFetchUserAgent(): string {
  return `Zy-User (${getZyCodeUserAgent()}; +https://zy.ai/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * 获取 API 请求的认证 headers
 * 为 Max/Pro 用户返回 OAuth headers，为普通用户返回 API key headers
 * 支持百炼 DashScope API Key
 */
export function getAuthHeaders(): AuthHeaders {
  const apiProvider = getAPIProvider()

  // 使用 OpenAI SDK 的平台（百炼、Ollama、智谱、Kimi、OpenAI 等）
  if (isOpenAIProvider(apiProvider)) {
    const apiKey = getApiKey()
    if (apiKey) {
      return {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    }
  }

  // Anthropic 原生 / 兼容端点使用 x-api-key
  if (isAnthropicProvider(apiProvider)) {
    const apiKey = getApiKey()
    if (apiKey) {
      return {
        headers: {
          'x-api-key': apiKey,
        },
      }
    }
  }

  // Google 等平台使用各自 SDK 的认证机制，不由此处提供通用 headers
  return {
    headers: {},
    error: 'No API key available',
  }
}

/**
 * 处理 OAuth 401 错误的包装器，通过强制刷新 token 并重试一次。
 * 解决本地过期检查与服务器不一致的时钟漂移场景。
 *
 * 重试时会再次调用请求闭包，因此它应重新读取认证信息
 * （例如通过 getAuthHeaders()）以获取刷新后的 token。
 *
 * 注意：bridgeApi.ts 有自己的 DI 注入版本——handleOAuth401Error
 * 传递性地引入 config.ts（约 1300 个模块），会破坏 SDK bundle。
 *
 * @param opts.also403Revoked - 也在 403 且响应体包含 "OAuth token has been
 *   revoked" 时重试（某些端点以此方式而非 401 表示撤销）。
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  try {
    return await request()
  } catch (err) {
    if (!axios.isAxiosError(err)) {
      throw err
    }
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) {
      throw err
    }
    const failedAccessToken = getZyAIOAuthTokens()?.accessToken
    if (!failedAccessToken) {
      throw err
    }
    await handleOAuth401Error(failedAccessToken)
    return await request()
  }
}
