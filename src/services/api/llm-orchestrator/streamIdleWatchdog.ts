import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../analytics/index.js'
import { logEvent } from '../../analytics/index.js'
import { logForDiagnosticsNoPII } from '../../../utils/diagLogs.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
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
    clear()
    warningTimer = setTimeout(() => {
      streamLog(`idle warning: no chunks received for ${warningMs / 1000}s`, { level: 'warn' })
      logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
    }, warningMs)
    timeoutTimer = setTimeout(() => {
      aborted = true
      firedAt = performance.now()
      streamLog(`idle timeout: no chunks received for ${timeoutMs / 1000}s, aborting stream`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
      logEvent('zy_streaming_idle_timeout', {
        model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id: (getRequestId() ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        timeout_ms: timeoutMs,
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
