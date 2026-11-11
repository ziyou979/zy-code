import memoize from 'lodash-es/memoize.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/services/config/config.js'
import { createDebugLog } from 'src/services/infra/debug.js'

const mcpLog = createDebugLog('mcp')

import { clearMcpAuthCache } from './client.js'
import type { ScopedMcpServerConfig } from './types.js'

/**
 * zy.ai（原 claude.ai）组织托管 MCP connector 的配置来源。
 *
 * 上游会带着 OAuth token 请求 Anthropic 后端 `/v1/mcp_servers` 拉取组织配置的 connector；
 * ZY Code 已移除全部 Anthropic 后端调用，这里改为本地 no-op：始终返回空配置。
 * 保留函数是因为 MCP 配置解析（-p 启动、交互两阶段加载、getAllMcpConfigs）的合流逻辑
 * 依赖它的返回值；整体删除 connector 合流与 `zyai-proxy` 类型留作后续清理。
 */
export const fetchZyAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    mcpLog('[zyai-mcp] Remote connectors are not supported; skipping')
    return {}
  },
)

/**
 * Clears the memoized cache for fetchZyAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearZyAIMcpConfigsCache(): void {
  fetchZyAIMcpConfigsIfEligible.cache.clear?.()
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
}

/**
 * Record that a zy.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markZyAiMcpConnected(name: string): void {
  saveGlobalConfig((current) => {
    const seen = current.zyAiMcpEverConnected ?? []
    if (seen.includes(name)) {
      return current
    }
    return { ...current, zyAiMcpEverConnected: [...seen, name] }
  })
}

export function hasZyAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().zyAiMcpEverConnected ?? []).includes(name)
}
