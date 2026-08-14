import { checkGate_CACHED_OR_BLOCKING } from '../../services/analytics/growthbook.js'

export type BackoffConfig = {
  connInitialMs: number
  connCapMs: number
  connGiveUpMs: number
  generalInitialMs: number
  generalCapMs: number
  generalGiveUpMs: number
  /** 关闭时从 SIGTERM 到 SIGKILL 的宽限期，默认 30s。 */
  shutdownGraceMs?: number
  /** stopWorkWithRetry 的基础延迟（最多尝试 3 次时按 1s/2s 退避），默认 1000ms。 */
  stopWorkBaseDelayMs?: number
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2_000,
  connCapMs: 120_000, // 2 分钟
  connGiveUpMs: 600_000, // 10 分钟
  generalInitialMs: 500,
  generalCapMs: 30_000,
  generalGiveUpMs: 600_000, // 10 分钟
}

/** 实时状态展示的刷新间隔（ms）。 */
export const STATUS_UPDATE_INTERVAL_MS = 1_000

export const SPAWN_SESSIONS_DEFAULT = 32

/**
 * 控制多会话启动模式（--spawn / --capacity / --create-session-in-dir）的 GrowthBook 开关。
 * 与 zy_ccr_bridge_multi_environment（每个 host:dir 对应多个环境）并列；本开关允许每个环境
 * 运行多个会话。通过定向规则分阶段发布：先覆盖 ants，再逐步开放给外部用户。
 *
 * 使用阻塞式开关检查，避免磁盘缓存过期或未命中时误拒绝访问。缓存值为 true 的快速路径仍会
 * 立即返回；只有冷启动路径需要等待服务端请求，同时该请求会写入磁盘缓存供下次使用。
 */
export async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('zy_ccr_bridge_multi_session')
}

/**
 * 返回轮询循环检测系统休眠与唤醒的阈值。该值必须大于最大退避上限，否则正常退避也会被
 * 误判为系统休眠，导致错误预算被反复重置。这里取连接退避上限的 2 倍，与
 * WebSocketTransport 和 replBridge 的做法一致。
 */
export function pollSleepDetectionThresholdMs(backoff: BackoffConfig): number {
  return backoff.connCapMs * 2
}
