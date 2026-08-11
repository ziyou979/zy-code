/**
 * 无头模式分析工具，用于测量 -p (print) 模式下每轮的延迟。
 *
 * 跟踪每轮关键时序阶段：
 * - 系统消息输出时间 (仅第 0 轮)
 * - 首个查询开始时间
 * - 首个 API 响应时间 (TTFT)
 *
 * 使用 Node.js 内置的 performance hooks API 进行标准时序测量。
 * 采样日志：100% ant 用户，5% 外部用户。
 *
 * 设置 ZY_CODE_PROFILE_STARTUP=1 可获取详细日志输出。
 */

import { getIsNonInteractiveSession } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { getPerformance } from '../telemetry/profilerBase.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
// 详细分析模式 - 与 startupProfiler 同一环境变量
// eslint-disable-next-line custom-rules/no-process-env-top-level
const DETAILED_PROFILING = isEnvTruthy(process.env.ZY_CODE_PROFILE_STARTUP)

// Statsig 日志采样：100% ant，5% 外部
// 模块加载时一次性决定 —— 非采样用户零分析成本
const STATSIG_SAMPLE_RATE = 0.05
// eslint-disable-next-line custom-rules/no-process-env-top-level
const STATSIG_LOGGING_SAMPLED = isInternalBuild() || Math.random() < STATSIG_SAMPLE_RATE

// 详细模式或 Statsig 采样时启用分析
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED

// 使用唯一前缀避免与其他分析标记冲突
const MARK_PREFIX = 'headless_'

// Track current turn number (auto-incremented by headlessProfilerStartTurn)
let currentTurnNumber = -1

/**
 * 从性能时间线清除所有无头分析标记
 */
function clearHeadlessMarks(): void {
  const perf = getPerformance()
  const allMarks = perf.getEntriesByType('mark')
  for (const mark of allMarks) {
    if (mark.name.startsWith(MARK_PREFIX)) {
      perf.clearMarks(mark.name)
    }
  }
}

/**
 * 开始新轮进行分析。清除之前的标记，增加轮号，
 * 并记录 turn_start。在处理每个用户消息开始时调用。
 */
export function headlessProfilerStartTurn(): void {
  // Only profile in headless/non-interactive mode
  if (!getIsNonInteractiveSession()) {
    return
  }
  // Only profile if enabled
  if (!SHOULD_PROFILE) {
    return
  }

  currentTurnNumber++
  clearHeadlessMarks()

  const perf = getPerformance()
  perf.mark(`${MARK_PREFIX}turn_start`)

  if (DETAILED_PROFILING) {
    logForDebugging(`[headlessProfiler] Started turn ${currentTurnNumber}`)
  }
}

/**
 * 使用给定名称记录检查点。
 * 仅在无头模式且分析启用时记录。
 */
export function headlessProfilerCheckpoint(name: string): void {
  // Only profile in headless/non-interactive mode
  if (!getIsNonInteractiveSession()) {
    return
  }
  // Only profile if enabled
  if (!SHOULD_PROFILE) {
    return
  }

  const perf = getPerformance()
  perf.mark(`${MARK_PREFIX}${name}`)

  if (DETAILED_PROFILING) {
    logForDebugging(`[headlessProfiler] Checkpoint: ${name} at ${perf.now().toFixed(1)}ms`)
  }
}

/**
 * 采样当前进程的内存使用情况并附加到当前 turn 的分析元数据。
 * 在每个 turn 结束时调用，帮助发现长会话内存退化（rss 单调上涨等）。
 *
 * 与现有的 perf mark 一样，仅在 SHOULD_PROFILE 为 true 时实际工作；
 * 非采样用户零成本。
 */
let lastMemorySample: NodeJS.MemoryUsage | null = null

export function headlessProfilerMemorySample(): void {
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (!SHOULD_PROFILE) {
    return
  }
  try {
    lastMemorySample = process.memoryUsage()
    if (DETAILED_PROFILING) {
      const mb = (n: number): number => Math.round(n / 1024 / 1024)
      logForDebugging(
        `[headlessProfiler] Memory: rss=${mb(lastMemorySample.rss)}MB heapUsed=${mb(lastMemorySample.heapUsed)}MB heapTotal=${mb(lastMemorySample.heapTotal)}MB external=${mb(lastMemorySample.external)}MB`,
      )
    }
  } catch {
    // process.memoryUsage 在极少数环境下会抛错，吞掉避免影响主流程
    lastMemorySample = null
  }
}

/**
 * 将当前 turn 的无头延迟指标记录到 Statsig。
 * 在每个 turn 结束时调用 (处理下一个用户消息前)。
 */
export function logHeadlessProfilerTurn(): void {
  // Only log in headless mode
  if (!getIsNonInteractiveSession()) {
    return
  }
  // Only log if enabled
  if (!SHOULD_PROFILE) {
    return
  }

  const perf = getPerformance()
  const allMarks = perf.getEntriesByType('mark')

  // Filter to only our headless marks
  const marks = allMarks.filter((mark) => mark.name.startsWith(MARK_PREFIX))
  if (marks.length === 0) {
    return
  }

  // Build checkpoint lookup (strip prefix for easier access)
  const checkpointTimes = new Map<string, number>()
  for (const mark of marks) {
    const name = mark.name.slice(MARK_PREFIX.length)
    checkpointTimes.set(name, mark.startTime)
  }

  const turnStart = checkpointTimes.get('turn_start')
  if (turnStart === undefined) {
    return
  }

  // Compute phase durations relative to turn_start
  const metadata: Record<string, number | string | undefined> = {
    turn_number: currentTurnNumber,
  }

  // Time to system message from process start (only meaningful for turn 0)
  // Use absolute time since perf_hooks startTime is relative to process start
  const systemMessageTime = checkpointTimes.get('system_message_yielded')
  if (systemMessageTime !== undefined && currentTurnNumber === 0) {
    metadata.time_to_system_message_ms = Math.round(systemMessageTime)
  }

  // Time to query start
  const queryStartTime = checkpointTimes.get('query_started')
  if (queryStartTime !== undefined) {
    metadata.time_to_query_start_ms = Math.round(queryStartTime - turnStart)
  }

  // Time to first response (first chunk from API)
  const firstChunkTime = checkpointTimes.get('first_chunk')
  if (firstChunkTime !== undefined) {
    metadata.time_to_first_response_ms = Math.round(firstChunkTime - turnStart)
  }

  // Query overhead (time between query start and API request sent)
  const apiRequestTime = checkpointTimes.get('api_request_sent')
  if (queryStartTime !== undefined && apiRequestTime !== undefined) {
    metadata.query_overhead_ms = Math.round(apiRequestTime - queryStartTime)
  }

  // Add checkpoint count for debugging
  metadata.checkpoint_count = marks.length

  // Add entrypoint for segmentation (sdk-ts, sdk-py, sdk-cli, or undefined)
  if (process.env.ZY_CODE_ENTRYPOINT) {
    metadata.entrypoint = process.env.ZY_CODE_ENTRYPOINT
  }

  // Log to Statsig if sampled
  if (STATSIG_LOGGING_SAMPLED) {
    logEvent(
      'zy_headless_latency',
      metadata as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    )
  }

  // Log detailed output if ZY_CODE_PROFILE_STARTUP=1
  if (DETAILED_PROFILING) {
    logForDebugging(
      `[headlessProfiler] Turn ${currentTurnNumber} metrics: ${jsonStringify(metadata)}`,
    )
  }
}
