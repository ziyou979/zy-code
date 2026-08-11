import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getStaticPricingForModel } from '../model/modelCapabilities.js'
import { getAPIProvider } from '../model/providers.js'
import { getOrCreateUserID } from '../config/config.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { getEventMetadata } from './metadata.js'

// 之前发送到 Datadog 的所有事件现在写入本地文件，
// 用于本地调试和审计。
const TELEMETRY_LOG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.zy',
  'telemetry',
)
const TELEMETRY_LOG_FILE = join(TELEMETRY_LOG_DIR, 'events.log')

const DEFAULT_FLUSH_INTERVAL_MS = 15000
const MAX_BATCH_SIZE = 100

const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  'chrome_bridge_disconnected',
  'chrome_bridge_tool_call_completed',
  'chrome_bridge_tool_call_error',
  'chrome_bridge_tool_call_started',
  'chrome_bridge_tool_call_timeout',
  'zy_api_error',
  'zy_api_success',
  'zy_brief_mode_enabled',
  'zy_brief_mode_toggled',
  'zy_brief_send',
  'zy_cancel',
  'zy_compact_failed',
  'zy_exit',
  'zy_flicker',
  'zy_init',
  'zy_model_fallback_triggered',
  'zy_oauth_error',
  'zy_oauth_success',
  'zy_oauth_token_refresh_failure',
  'zy_oauth_token_refresh_success',
  'zy_oauth_token_refresh_lock_acquiring',
  'zy_oauth_token_refresh_lock_acquired',
  'zy_oauth_token_refresh_starting',
  'zy_oauth_token_refresh_completed',
  'zy_oauth_token_refresh_lock_releasing',
  'zy_oauth_token_refresh_lock_released',
  'zy_query_error',
  'zy_session_file_read',
  'zy_started',
  'zy_tool_use_error',
  'zy_tool_use_granted_in_prompt_permanent',
  'zy_tool_use_granted_in_prompt_temporary',
  'zy_tool_use_rejected_in_prompt',
  'zy_tool_use_success',
  'zy_uncaught_exception',
  'zy_unhandled_rejection',
  'zy_voice_recording_started',
  'zy_voice_toggled',
  'zy_team_mem_sync_pull',
  'zy_team_mem_sync_push',
  'zy_team_mem_sync_started',
  'zy_team_mem_entries_capped',
])

const TAG_FIELDS = [
  'arch',
  'clientType',
  'errorType',
  'http_status_range',
  'http_status',
  'kairosActive',
  'model',
  'platform',
  'provider',
  'skillMode',
  'subscriptionType',
  'toolName',
  'userBucket',
  'userType',
  'version',
  'versionBase',
]

function camelToSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

type DatadogLog = {
  ddsource: string
  ddtags: string
  message: string
  service: string
  hostname: string
  [key: string]: unknown
}

let logBatch: DatadogLog[] = []
let flushTimer: NodeJS.Timeout | null = null
let datadogInitialized: boolean | null = null

function flushLogs(): void {
  if (logBatch.length === 0) {
    return
  }

  const logsToWrite = logBatch
  logBatch = []

  try {
    mkdirSync(TELEMETRY_LOG_DIR, { recursive: true })
    const line = logsToWrite.map((entry) => JSON.stringify(entry)).join('\n')
    appendFileSync(TELEMETRY_LOG_FILE, `${line}\n`, 'utf8')
  } catch {
    // If we can't write to the local file, silently drop the events.
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return
  }

  flushTimer = setTimeout(() => {
    flushTimer = null
    flushLogs()
  }, getFlushIntervalMs()).unref()
}

export const initializeDatadog = memoize(async (): Promise<boolean> => {
  try {
    mkdirSync(TELEMETRY_LOG_DIR, { recursive: true })
    datadogInitialized = true
    return true
  } catch {
    datadogInitialized = false
    return false
  }
})

/**
 * 刷新剩余 Datadog 日志并关闭。
 * 从 gracefulShutdown() 调用，在 process.exit() 前，
 * 因为 forceExit() 会阻止 beforeExit 处理器触发。
 */
export function shutdownDatadog(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushLogs()
}

// 注意：通过 src/services/analytics/index.ts > logEvent 使用
export async function trackDatadogEvent(
  eventName: string,
  properties: { [key: string]: boolean | number | undefined },
): Promise<void> {
  // 3P 提供商 (Bedrock, Vertex, Foundry) 不发送事件
  if (getAPIProvider() !== 'anthropic') {
    return
  }

  // 快速路径：若有缓存结果则使用，避免 await 开销
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) {
    return
  }

  try {
    const metadata = await getEventMetadata({
      model: properties.model,
      betas: properties.betas,
    })
    // 解构以避免重复的 envContext (一次嵌套、一次扁平化)
    const { envContext, ...restMetadata } = metadata
    const allData: Record<string, unknown> = {
      ...restMetadata,
      ...envContext,
      ...properties,
      userBucket: getUserBucket(),
    }

    // 为降低基数将 MCP 工具名归一化为 "mcp"
    if (typeof allData.toolName === 'string' && allData.toolName.startsWith('mcp__')) {
      allData.toolName = 'mcp'
    }

    // 为降低基数归一化模型名 (仅外部用户)
    if (!isInternalBuild() && typeof allData.model === 'string') {
      const rawModel = allData.model.replace(/\[1m]$/i, '')
      allData.model = getStaticPricingForModel(rawModel) ? rawModel : 'other'
    }

    // 截断开发版本为基础版本+日期 (移除时间戳和 sha 以降低基数)
    // 例如 "2.0.53-dev.20251124.t173302.sha526cc6a" -> "2.0.53-dev.20251124"
    if (typeof allData.version === 'string') {
      allData.version = allData.version.replace(
        /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
        '$1',
      )
    }

    // 将 status 转换为 http_status 和 http_status_range 以避免 Datadog 保留字段
    if (allData.status !== undefined && allData.status !== null) {
      const statusCode = String(allData.status)
      allData.http_status = statusCode

      // 确定状态范围 (1xx, 2xx, 3xx, 4xx, 5xx)
      const firstDigit = statusCode.charAt(0)
      if (firstDigit >= '1' && firstDigit <= '5') {
        allData.http_status_range = `${firstDigit}xx`
      }

      // 移除原始 status 字段以避免与 Datadog 的保留字段冲突
      delete allData.status
    }

    // 构建 ddtags 以高基数字段供过滤。
    // 预置 event:<name> 以便通过日志搜索 API 按事件名搜索 ——
    // `message` 字段 (eventName 也在其中) 是 DD 保留字段，
    // 仪表盘部件查询或聚合 API 无法查询。
    // 参见 scripts/release/MONITORING.md。
    const allDataRecord = allData
    const tags = [
      `event:${eventName}`,
      ...TAG_FIELDS.filter(
        (field) => allDataRecord[field] !== undefined && allDataRecord[field] !== null,
      ).map((field) => `${camelToSnakeCase(field)}:${allDataRecord[field]}`),
    ]

    const log: DatadogLog = {
      ddsource: 'nodejs',
      ddtags: tags.join(','),
      message: eventName,
      service: 'zy-code',
      hostname: 'zy-code',
      env: isInternalBuild() ? 'internal' : 'external',
    }

    // 添加所有字段为可搜索属性 (不在标签中重复)
    for (const [key, value] of Object.entries(allData)) {
      if (value !== undefined && value !== null) {
        log[camelToSnakeCase(key)] = value
      }
    }

    logBatch.push(log)

    // 批次满则立即刷新，否则排期
    if (logBatch.length >= MAX_BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flushLogs()
    } else {
      scheduleFlush()
    }
  } catch {
    // 静默忽略 —— 本地文件写入失败非关键。
  }
}

const NUM_USER_BUCKETS = 30

/**
 * 获取用户 ID 所在的"桶"。
 *
 * 为告警目的，我们希望按受问题影响的用户数告警，
 * 而非事件数 —— 通常少数用户会产生大量事件
 * (如因重试)。为在不直接计数用户 ID 破坏基数的情况下
 * 近似此值，我们对用户 ID 哈希并将其分配到固定数量的桶之一。
 *
 * 这让我们能通过计数唯一桶来估算唯一用户数，
 * 同时保护用户隐私并降低基数。
 */
let getUserBucket: () => number
getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})

function getFlushIntervalMs(): number {
  // Allow tests to override to not block on the default flush interval.
  return (
    parseInt(process.env.ZY_CODE_DATADOG_FLUSH_INTERVAL_MS || '', 10) || DEFAULT_FLUSH_INTERVAL_MS
  )
}
