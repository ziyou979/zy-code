import { getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, withOAuth401Retry } from '../http/http.js'
import { logError } from '../../services/infra/log.js'
import { memoizeWithTTLAsync } from '../../utils/memoize.js'
import { isEssentialTrafficOnly } from '../telemetry/privacyLevel.js'
import { getZyCodeUserAgent } from '../../services/http/userAgent.js'

type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

// 内存 TTL — 在单个进程内去重调用
const CACHE_TTL_MS = 60 * 60 * 1000

// 磁盘 TTL — 组织设置很少变化。当磁盘缓存比此值更新时，
// 完全跳过网络（无后台刷新）。这就是将 N 次 `zy -p`
// 调用合并为约 1 次 API 调用/天的机制。
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 调用 API 检查指标是否启用的内部函数
 * 由 memoizeWithTTLAsync 包装以添加缓存行为
 */
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`认证错误：${authResult.error}`)
  }

  const _headers = {
    'Content-Type': 'application/json',
    'User-Agent': getZyCodeUserAgent(),
    ...authResult.headers,
  }

  // TODO: 等待 ZY Code 自建服务就绪后启用
  // const endpoint = `${getOauthConfig().BASE_API_URL}/api/zy_code/organizations/metrics_enabled`
  // const response = await axios.get<MetricsEnabledResponse>(endpoint, {
  //   headers,
  //   timeout: 5000,
  // })
  // return response.data
  return { metrics_logging_enabled: false }
}

async function _checkMetricsEnabledAPI(): Promise<MetricsStatus> {
  // 事件熔断开关：当非必要流量被禁用时跳过网络调用。
  // 返回 enabled:false 以在消费端卸载（bigqueryExporter
  // 跳过导出）。与下方非订阅者早返回的形态一致。
  if (isEssentialTrafficOnly()) {
    return { enabled: false, hasError: false }
  }

  try {
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(`指标退出 API 响应：enabled=${data.metrics_logging_enabled}`)

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    logForDebugging(`检查指标退出状态失败：${errorMessage(error)}`)
    logError(error)
    return { enabled: false, hasError: true }
  }
}

// 创建带自定义错误处理的记忆化版本
const memoizedCheckMetrics = memoizeWithTTLAsync(_checkMetricsEnabledAPI, CACHE_TTL_MS)

/**
 * 获取（内存记忆化）并在变更时持久化到磁盘。
 * 错误不被持久化 — 瞬态故障不应覆盖已知的良好磁盘值。
 */
async function refreshMetricsStatus(): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics()
  if (result.hasError) {
    return result
  }

  const cached = getGlobalConfig().metricsStatusCache
  const unchanged = cached !== undefined && cached.enabled === result.enabled
  // 未变更且时间戳仍然新鲜时跳过写入 — 避免并发调用者
  // 竞争过期磁盘条目时都尝试写入的配置抖动。
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  saveGlobalConfig((current) => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
    },
  }))
  return result
}

/**
 * 检查当前组织是否启用了指标。
 *
 * 两级缓存：
 * - 磁盘（24h TTL）：跨进程重启存活。新鲜磁盘缓存 → 零网络。
 * - 内存（1h TTL）：在进程内去重后台刷新。
 *
 * 调用方（bigqueryExporter）容忍过期读取 — 24 小时窗口内
 * 的一次遗漏导出或额外导出是可接受的。
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // 无订阅上下文 — 服务密钥 OAuth 会话检查不适用
  const cached = getGlobalConfig().metricsStatusCache
  if (cached) {
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig 的回退路径（config.ts:731）在锁和
      // 回退写入都失败时可能抛出异常 — 在此捕获，以免
      // 即发即弃变成未处理的拒绝。
      void refreshMetricsStatus().catch(logError)
    }
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

  // 此机器首次运行：阻塞网络以填充磁盘。
  return refreshMetricsStatus()
}

// 仅用于测试目的导出
export const _clearMetricsEnabledCacheForTesting = (): void => {
  memoizedCheckMetrics.cache.clear()
}
