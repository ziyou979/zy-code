/**
 * 分析服务 - 事件日志的公共 API
 *
 * 此模块是 Zy CLI 中分析事件的主要入口点。
 *
 * 设计：此模块无依赖以避免导入循环。
 * 事件在调用 attachAnalyticsSink() 进行应用初始化前会被排队。
 * 接收器处理向 Datadog 和直接 API 事件日志的路由。
 */

/**
 * 用于验证分析元数据不包含敏感数据的标记类型
 *
 * 此类型强制显式验证被记录的字符串值
 * 不包含代码片段、文件路径或其他敏感信息。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 通过 `_PROTO_*` payload 键路由到标记 PII 的 proto 列的值的标记类型。
 * 目标 BQ 列有特权访问控制，因此未脱敏值可接受 —— 与通用访问后端不同。
 *
 * sink.ts 在 Datadog 分发前剥离 `_PROTO_*` 键；仅直接 API
 * 导出器 (zyEventExporter) 看到它们并将它们提升到顶级 proto 字段。
 * 单次 stripProtoFields 调用保护所有非直接 API 接收器 —— 无需每个接收器单独过滤。
 *
 * 用法：`rawName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * 从目标为通用访问存储的 payload 中剥离 `_PROTO_*` 键。
 * 使用场景：
 *   - sink.ts：Datadog 分发前 (永不见 PII 标记值)
 *   - zyEventExporter：将已知 _PROTO_* 键提升到 proto 字段后，
 *     防御性地剥离 additional_metadata —— 防止未来未识别的
 *     _PROTO_foo 静默落入 BQ JSON blob。
 *
 * 无 _PROTO_ 键时返回原输入 (同一引用)。
 */
import { isInternalBuild } from '../../services/infra/envUtils.js'

export function stripProtoFields<V>(metadata: Record<string, V>): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  return result ?? metadata
}

// Internal type for logEvent metadata - different from the enriched EventMetadata in metadata.ts
type LogEventMetadata = { [key: string]: boolean | number | undefined }

type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

/**
 * 分析后端的接收器接口
 */
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (eventName: string, metadata: LogEventMetadata) => Promise<void>
}

// Event queue for events logged before sink is attached
const eventQueue: QueuedEvent[] = []

// Sink - initialized during app startup
let sink: AnalyticsSink | null = null

/**
 * 附接将接收所有事件的分析接收器。
 * 排队的事件通过 queueMicrotask 异步排出，以避免
 * 给启动路径增加延迟。
 *
 * 幂等：如果接收器已附接，则为空操作。这允许
 * 从 preAction hook (子命令) 和 setup() (默认命令)
 * 同时调用而无需协调。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) {
    return
  }
  sink = newSink

  // Drain the queue asynchronously to avoid blocking startup
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0

    // Log queue size for ants to help debug analytics initialization timing
    if (isInternalBuild()) {
      sink.logEvent('analytics_sink_attached', {
        queued_event_count: queuedEvents.length,
      })
    }

    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}

/**
 * 将事件记录到分析后端 (同步)
 *
 * 事件可能基于 'zy_event_sampling_config' 动态配置被采样。
 * 采样时，sample_rate 会添加到事件元数据中。
 *
 * 若无接收器附接，事件会排队并在接收器附接时排出。
 */
export function logEvent(
  eventName: string,
  // intentionally no strings unless AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  // to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

/**
 * 将事件记录到分析后端 (异步)
 *
 * 事件可能基于 'zy_event_sampling_config' 动态配置被采样。
 * 采样时，sample_rate 会添加到事件元数据中。
 *
 * 若无接收器附接，事件会排队并在接收器附接时排出。
 */
export async function logEventAsync(
  eventName: string,
  // intentionally no strings, to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: true })
    return
  }
  await sink.logEventAsync(eventName, metadata)
}

/**
 * 重置分析状态，仅供测试使用。
 * @internal
 */
export function _resetForTesting(): void {
  sink = null
  eventQueue.length = 0
}
