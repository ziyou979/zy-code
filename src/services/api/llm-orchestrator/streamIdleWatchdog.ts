import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../analytics/index.js'
import { logEvent } from '../../analytics/index.js'
import { logForDiagnosticsNoPII } from '../../telemetry/diagLogs.js'
import { isEnvTruthy } from '../../../services/infra/envUtils.js'
import { streamLog } from './nonStreaming.js'

type Options = {
  model: string
  getRequestId: () => string | null | undefined
  releaseStreamResources: () => void
}

/** 管理流式响应的警告和硬超时计时器。 */
export function createStreamIdleWatchdog({
  model,
  getRequestId,
  releaseStreamResources,
}: Options): {
  readonly aborted: boolean
  readonly firedAt: number | null
  reset: () => void
  clear: () => void
  resetFiredAt: () => void
} {
  const enabled = isEnvTruthy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)
  const timeoutMs = enabled
    ? parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    : 300_000
  const warningMs = timeoutMs / 2
  let aborted = false
  let firedAt: number | null = null
  let warningTimer: ReturnType<typeof setTimeout> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (warningTimer !== null) clearTimeout(warningTimer)
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
    warningTimer = null
    timeoutTimer = null
  }
  const reset = (): void => {
    // 同一响应可能有数万个事件；复用计时器，避免每个 delta 都分配两个对象。
    // 警告已触发时重新创建，保持“下一段空闲仍会告警”的语义。
    if (warningTimer !== null) warningTimer.refresh()
    else
      warningTimer = setTimeout(() => {
        warningTimer = null
        streamLog(`idle warning: no chunks received for ${warningMs / 1000}s`, { level: 'warn' })
        logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
      }, warningMs)
    if (timeoutTimer !== null) timeoutTimer.refresh()
    else
      timeoutTimer = setTimeout(() => {
        timeoutTimer = null
        aborted = true
        firedAt = performance.now()
        streamLog(`idle timeout: no chunks received for ${timeoutMs / 1000}s, aborting stream`, {
          level: 'error',
        })
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        // 与 stall summary 区分：此路径更接近 half-open/挂死连接，供重试策略采样
        logEvent('zy_streaming_idle_timeout', {
          model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (getRequestId() ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: timeoutMs,
          likely_half_open: true,
        })
        logEvent('zy_streaming_stale_connection_retry', {
          model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (getRequestId() ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source: 'idle_watchdog' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        releaseStreamResources()
      }, timeoutMs)
  }
  return {
    get aborted() {
      return aborted
    },
    get firedAt() {
      return firedAt
    },
    reset,
    clear,
    resetFiredAt: () => {
      firedAt = null
    },
  }
}
