/**
 * Windows 专用：周期性清空进程工作集，缓解任务管理器显示的"内存虚高"。
 *
 * 背景（2026-08 实测）：zy-code 每轮查询/渲染会分配大量临时页面（API 请求体
 * 序列化、流式响应、渲染帧）。macOS 的 Mach VM 会自动回收已释放的页面，
 * 而 Windows 工作集不会主动 trim（除非系统内存压力触发），导致释放过的
 * 页面全部残留在工作集里，任务管理器显示的 RSS 单调爬升、只涨不落。
 * 实测：RSS 3.5GB 中约 94% 是 dead 页面，EmptyWorkingSet 后瞬间降至 187MB，
 * 进程功能不受影响（真实占用 heapUsed ~150MB 一直正常）。
 *
 * 方案：RSS 超过阈值时调用 kernel32!SetProcessWorkingSetSize(h, -1, -1)
 * 清空工作集 —— dead 页面立即释放；活跃页面按需重载（页面通常在 standby
 * list 中，重载成本低，代价是瞬间页错误导致轻微卡顿，故设置冷却时间）。
 * 仅 Windows 生效，其他平台 no-op。
 */

import { dlopen, type Pointer } from 'bun:ffi'
import { isEnvTruthy } from '../infra/envUtils.js'

const MB = 1024 * 1024
const GB = 1024 * MB

/** RSS 超过该值才触发 trim（与 memoryMonitor 的 warn 阈值一致） */
const DEFAULT_TRIM_THRESHOLD_BYTES = 1.5 * GB
/** 检查间隔 */
const DEFAULT_CHECK_INTERVAL_MS = 30_000
/** 两次 trim 之间的最小间隔，避免频繁清空工作集造成抖动 */
const DEFAULT_COOLDOWN_MS = 5 * 60_000
/** 连续空闲达到该时长后才允许驱逐，避免流式响应期间制造 page fault 抖动。 */
const DEFAULT_MIN_IDLE_MS = 30_000

type TrimApi = {
  GetCurrentProcess: () => Pointer | null
  SetProcessWorkingSetSize: (handle: Pointer | null, min: bigint, max: bigint) => boolean
}

let trimApi: TrimApi | null | undefined

/** 懒加载 kernel32 API。ffi 失败（非 Windows 或异常）时返回 null 并记住结果。 */
function getTrimApi(): TrimApi | null | undefined {
  if (trimApi !== undefined) {
    return trimApi
  }
  if (typeof Bun === 'undefined' || process.platform !== 'win32') {
    trimApi = null
    return trimApi
  }
  try {
    const lib = dlopen('kernel32.dll', {
      GetCurrentProcess: { args: [], returns: 'ptr' },
      SetProcessWorkingSetSize: { args: ['ptr', 'u64', 'u64'], returns: 'bool' },
    })
    trimApi = {
      GetCurrentProcess: () => lib.symbols.GetCurrentProcess(),
      SetProcessWorkingSetSize: (handle, min, max) =>
        lib.symbols.SetProcessWorkingSetSize(handle, min, max),
    }
  } catch {
    // dlopen 失败（理论上仅非 Windows 才会）——静默禁用，trim 是尽力而为的优化
    trimApi = null
  }
  return trimApi
}

let lastTrimAt = 0

/**
 * 清空当前进程工作集。受冷却时间限制，返回是否实际执行了 trim。
 * 任何失败都静默返回 false（trim 是尽力而为，不影响主流程）。
 */
export function trimWorkingSetNow(now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
  if (now - lastTrimAt < cooldownMs) {
    return false
  }
  const api = getTrimApi()
  if (!api) {
    return false
  }
  try {
    const handle = api.GetCurrentProcess()
    // GetCurrentProcess 返回伪句柄，正常不会为 null；防御性跳过
    if (handle === null) {
      return false
    }
    // SIZE_T(-1) 表示"设置为尽可能小"——即清空工作集（EmptyWorkingSet 语义）
    if (api.SetProcessWorkingSetSize(handle, -1n, -1n)) {
      lastTrimAt = now
      return true
    }
  } catch {
    // 静默失败
  }
  return false
}

/**
 * 启动周期性工作集 trim。仅 Windows 生效，其他平台直接返回。
 * 定时器 unref，不阻止进程退出。
 */
export function initWinWorkingSetTrim(opts?: {
  thresholdBytes?: number
  checkIntervalMs?: number
  cooldownMs?: number
  minIdleMs?: number
  isActive?: () => boolean
}): void {
  if (process.platform !== 'win32' || isEnvTruthy(process.env.ZY_CODE_DISABLE_WORKING_SET_TRIM)) {
    return
  }
  const threshold = opts?.thresholdBytes ?? DEFAULT_TRIM_THRESHOLD_BYTES
  const intervalMs = opts?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const minIdleMs = opts?.minIdleMs ?? DEFAULT_MIN_IDLE_MS
  const isActive = opts?.isActive ?? (() => false)
  let idleSince = 0
  const timer = setInterval(() => {
    try {
      const now = Date.now()
      if (isActive()) {
        idleSince = 0
        return
      }
      if (idleSince === 0) {
        idleSince = now
        return
      }
      if (now - idleSince >= minIdleMs && process.memoryUsage().rss > threshold) {
        // 先让 JSC 回收已断引用对象，再驱逐仍留在 Working Set 的可重载页面。
        // 两者都只在高 RSS 且持续空闲时运行，避免把每轮 GC/trim 变成常规路径。
        Bun.gc(true)
        trimWorkingSetNow(Date.now(), cooldownMs)
      }
    } catch {
      // 采样失败忽略
    }
  }, intervalMs)
  timer.unref()
}
