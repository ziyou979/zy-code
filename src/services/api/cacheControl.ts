// @ts-nocheck
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import {
  getDefaultCompactModel,
  getDefaultStandardModel,
  getDefaultAdvancedModel,
} from '../../utils/model/model.js'
import type { CacheScope } from '../../utils/api.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  getPromptCache1hEligible,
  setPromptCache1hEligible,
  getPromptCache1hAllowlist,
  setPromptCache1hAllowlist,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { splitSysPromptPrefix } from '../../utils/api.js'
import type { TextBlock } from '../../types/llm.js'

export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 检查是否应对 compact 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const compactModel = getDefaultCompactModel()
    if (model === compactModel) return false
  }

  // 检查是否应对 standard 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const standardModel = getDefaultStandardModel()
    if (model === standardModel) return false
  }

  // 检查是否应对 advanced 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const advancedModel = getDefaultAdvancedModel()
    if (model === advancedModel) return false
  }

  return true
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 判断提示词缓存是否应使用 1h TTL。
 *
 * 仅在以下情况下应用：
 * 1. 用户符合条件（ant 用户或在限额内的订阅者）
 * 2. 查询来源匹配 GrowthBook 允许列表中的模式
 *
 * GrowthBook 配置结构：{ allowlist: string[] }
 * 模式支持尾随 '*' 用于前缀匹配。
 * 示例：
 * - { allowlist: ["repl_main_thread*", "sdk"] } — 仅主线程 + SDK
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } — 还包括子代理
 * - { allowlist: ["*"] } — 所有来源
 *
 * 允许列表缓存在 STATE 中以保证会话稳定性 — 防止 GrowthBook
 * 的磁盘缓存在请求中途更新时导致混合 TTL。
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 第三方 Bedrock 用户通过环境变量选择 1h TTL — 他们自行管理计费
  // 无需 GrowthBook 控制，因为第三方用户没有配置 GrowthBook
  if (getAPIProvider() === 'bedrock' && isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)) {
    return true
  }

  // 将资格状态锁存到引导状态中以保证会话稳定性 — 防止
  // 会话中途的超额变更导致 cache_control TTL 变化，这会
  // 破坏服务端提示词缓存（每次变更约 ~20K 令牌）。
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = isInternalBuild()
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // 缓存允许列表到引导状态中以保证会话稳定性 — 防止
  // GrowthBook 的磁盘缓存在请求中途更新时导致混合 TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('zy_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some((pattern) =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlock[] {
  // 重要：不要再添加任何用于缓存的块，否则会收到 400 错误
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map((block) => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}
