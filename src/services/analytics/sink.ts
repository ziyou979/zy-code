/**
 * 分析事件汇实现
 *
 * 此模块包含实际的分析事件路由逻辑，应在应用启动时初始化。
 * 它将事件路由到 Datadog 和直接 API 事件日志。
 *
 * 用法：在应用启动时调用 initializeAnalyticsSink() 以附加事件汇。
 */

import { trackDatadogEvent } from './datadog.js'
import { logEventToZy, shouldSampleEvent } from './zyEventLogger.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from './growthbook.js'
import { attachAnalyticsSink, stripProtoFields } from './index.js'
import { isSinkKilled } from './sinkKillswitch.js'

// 匹配 logEvent 元数据签名的本地类型
type LogEventMetadata = { [key: string]: boolean | number | undefined }

const DATADOG_GATE_NAME = 'zy_log_datadog_events'

// 模块级开关状态 - 初始为 undefined，在启动时初始化
let isDatadogGateEnabled: boolean | undefined = undefined

/**
 * 检查 Datadog 追踪是否启用。
 * 若尚未初始化，则回退到上次会话的缓存值。
 */
function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) {
    return false
  }
  if (isDatadogGateEnabled !== undefined) {
    return isDatadogGateEnabled
  }

  // 回退到上次会话的缓存值
  try {
    return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
  } catch {
    return false
  }
}

/**
 * 记录事件（同步实现）
 */
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // 检查此事件是否应被采样
  const sampleResult = shouldSampleEvent(eventName)

  // 若采样结果为 0，表示该事件未被选中记录
  if (sampleResult === 0) {
    return
  }

  // 若采样结果为正数，将其添加到元数据中
  const metadataWithSampleRate =
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata

  if (shouldTrackDatadog()) {
    // Datadog 是通用访问后端 — 移除 _PROTO_* 键
    // （未脱敏的 PII 标记值仅用于直接 API 的特权列）。
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 直接 API 接收完整负载（包括 _PROTO_*）— 导出器
  // 自行解构并将这些键路由到 proto 字段。
  logEventToZy(eventName, metadataWithSampleRate)
}

/**
 * 记录事件（异步实现）
 *
 * 移除 Segment 后，剩余的两个事件汇都是即发即弃的，
 * 因此这里只是包装同步实现 — 保留以维持事件汇接口契约。
 */
function logEventAsyncImpl(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEventImpl(eventName, metadata)
  return Promise.resolve()
}

/**
 * 在启动时初始化分析开关。
 *
 * 从服务器更新开关值。早期事件使用上次会话的缓存值，
 * 以避免初始化期间的数据丢失。
 *
 * 在 main.tsx 的 setupBackend() 中调用。
 */
export function initializeAnalyticsGates(): void {
  isDatadogGateEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
}

/**
 * 初始化分析事件汇。
 *
 * 在应用启动时调用以附加分析后端。
 * 在此之前记录的任何事件将被排队并排空。
 *
 * 幂等操作：可安全多次调用（后续调用为空操作）。
 */
export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
