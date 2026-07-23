import { checkGate_CACHED_OR_BLOCKING } from '../../services/analytics/growthbook.js'

export type BackoffConfig = {
  connInitialMs: number
  connCapMs: number
  connGiveUpMs: number
  generalInitialMs: number
  generalCapMs: number
  generalGiveUpMs: number
  /** SIGTERM→SIGKILL grace period on shutdown. Default 30s. */
  shutdownGraceMs?: number
  /** stopWorkWithRetry base delay (1s/2s/4s backoff). Default 1000ms. */
  stopWorkBaseDelayMs?: number
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2_000,
  connCapMs: 120_000, // 2 minutes
  connGiveUpMs: 600_000, // 10 minutes
  generalInitialMs: 500,
  generalCapMs: 30_000,
  generalGiveUpMs: 600_000, // 10 minutes
}

/** Status update interval for the live display (ms). */
export const STATUS_UPDATE_INTERVAL_MS = 1_000

export const SPAWN_SESSIONS_DEFAULT = 32

/**
 * GrowthBook gate for multi-session spawn modes (--spawn / --capacity / --create-session-in-dir).
 * Sibling of zy_ccr_bridge_multi_environment (multiple envs per host:dir) —
 * this one enables multiple sessions per environment.
 * Rollout staged via targeting rules: ants first, then gradual external.
 *
 * Uses the blocking gate check so a stale disk-cache miss doesn't unfairly
 * deny access. The fast path (cache has true) is still instant; only the
 * cold-start path awaits the server fetch, and that fetch also seeds the
 * disk cache for next time.
 */
export async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('zy_ccr_bridge_multi_session')
}

/**
 * Returns the threshold for detecting system sleep/wake in the poll loop.
 * Must exceed the max backoff cap — otherwise normal backoff delays trigger
 * false sleep detection (resetting the error budget indefinitely). Using
 * 2× the connection backoff cap, matching the pattern in WebSocketTransport
 * and replBridge.
 */
export function pollSleepDetectionThresholdMs(backoff: BackoffConfig): number {
  return backoff.connCapMs * 2
}
