import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'

// 混淆名称：按接收器的分析熔断开关
const SINK_KILLSWITCH_CONFIG_NAME = 'zy_frond_boric'

export type SinkName = 'datadog' | 'anthropic' | 'zyEvent'

/**
 * GrowthBook JSON 配置，用于禁用单个分析接收器。
 * 结构：{ datadog?: boolean, anthropic?: boolean }
 * 键为 true 时停止向该接收器的所有分发。
 * 默认 {} (无熔断)。失败开放：缺失/格式错误的配置 = 接收器保持开启。
 *
 * 注意：不得从 isZyEventLoggingEnabled() 内部调用 -
 * growthbook.ts:isGrowthBookEnabled() 会调用它，所以这里查找会递归。
 * 应在每个事件分发点调用。
 */
export function isSinkKilled(sink: SinkName): boolean {
  const config = getDynamicConfig_CACHED_MAY_BE_STALE<Partial<Record<SinkName, boolean>>>(
    SINK_KILLSWITCH_CONFIG_NAME,
    {},
  )
  // getFeatureValue_CACHED_MAY_BE_STALE 只用 `!== undefined` 判断，因此缓存的 JSON null
  // 会直接透传，而不会回退到 {}。
  return config?.[sink] === true
}
