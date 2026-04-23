import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * 基于时间的 microcompact 的 GrowthBook 配置。
 *
 * 当距上次主循环助手消息的间隔超过阈值时触发内容清除
 * microcompact — 服务器端提示缓存几乎肯定已过期，
 * 因此完整前缀无论如何都会被重写。在请求之前清除旧工具结果
 * 可以缩小被重写的内容。
 *
 * 在 API 调用之前运行（在 microcompactMessages 中，callModel 的上游），
 * 以便收缩后的提示是实际发送的内容。在第一次未命中之后运行
 * 只对后续轮次有帮助。
 *
 * 仅主线程 — 子代理的生存期很短，基于间隔的驱逐不适用。
 */
export type TimeBasedMCConfig = {
  /** 主开关。为 false 时，基于时间的 microcompact 是空操作。 */
  enabled: boolean
  /** 当（现在 − 上次助手时间戳）超过此分钟数时触发。
   *  60 是安全选择：服务器的 1 小时缓存 TTL 保证对所有用户都已过期，
   *  所以我们永远不会强制一个本不会发生的未命中。 */
  gapThresholdMinutes: number
  /** 保留最近多少个可压缩的工具结果。
   *  设置时优先于任何默认值；更旧的结果将被清除。 */
  keepRecent: number
}

const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  // 提升 GB 读取，使曝光在每个求值路径上触发，而不仅是
  // 当调用者的其他条件（querySource、messages.length）通过时。
  return getFeatureValue_CACHED_MAY_BE_STALE<TimeBasedMCConfig>(
    'zy_slate_heron',
    TIME_BASED_MC_CONFIG_DEFAULTS,
  )
}
