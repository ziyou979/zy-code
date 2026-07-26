/**
 * 运行时内存监控服务。
 * 定期采样 RSS/heap，超过阈值时记录警告并可选触发诊断。
 */
import { getHeapStatistics } from 'node:v8'
import { logForDebugging } from '../../services/infra/debug.js'
import { logError } from '../../services/infra/log.js'

const MB = 1024 * 1024
const GB = 1024 * MB

/** 监控配置 */
export type MemoryMonitorConfig = {
  /** RSS 警告阈值（默认 1.5GB） */
  warnThresholdRss: number
  /** RSS 严重阈值，超过自动触发 heap dump（默认 2.0GB） */
  criticalThresholdRss: number
  /** 堆使用率警告阈值（默认 80%） */
  warnHeapRatio: number
  /** 采样间隔（毫秒，默认 30 秒） */
  sampleIntervalMs: number
  /** 是否自动触发 heap dump（默认 false） */
  autoHeapDump: boolean
  /** heap dump 回调（注入避免循环依赖） */
  onHeapDump?: () => Promise<void>
}

const DEFAULT_CONFIG: MemoryMonitorConfig = {
  warnThresholdRss: 1.5 * GB,
  criticalThresholdRss: 2.0 * GB,
  warnHeapRatio: 0.8,
  sampleIntervalMs: 30_000,
  autoHeapDump: false,
  onHeapDump: undefined,
}

type MemorySample = {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  timestamp: number
}

export class MemoryMonitor {
  private config: MemoryMonitorConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private samples: MemorySample[] = []
  private maxRss = 0
  private warnedRss = false
  private warningCooldown = 0

  constructor(config?: Partial<MemoryMonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 获取当前内存快照 */
  snapshot(): MemorySample & { heapLimit: number; heapRatio: number; mbPerHour: number } {
    const usage = process.memoryUsage()
    const heapStats = getHeapStatistics()
    const now = Date.now()
    const uptimeMs = now - (this.samples[0]?.timestamp ?? now)
    const uptimeHours = uptimeMs / 3600000

    const sample: MemorySample = {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      timestamp: now,
    }

    // 计算增长率（基于第一个和最新样本）
    const first = this.samples[0]
    let mbPerHour = 0
    if (first && uptimeHours > 0) {
      mbPerHour = (usage.rss - first.rss) / (1024 * 1024) / uptimeHours
    }

    return {
      ...sample,
      heapLimit: heapStats.heap_size_limit,
      heapRatio: usage.heapUsed / Math.max(heapStats.heap_size_limit, 1),
      mbPerHour,
    }
  }

  /** 开始监控 */
  start(): void {
    if (this.timer) return

    // 立即采样一次
    this.recordSample()

    this.timer = setInterval(() => {
      this.tick()
    }, this.config.sampleIntervalMs)
    this.timer.unref()
  }

  /** 停止监控 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 获取内存报告摘要 */
  getSummary(): string {
    const s = this.snapshot()
    const mb = (n: number) => Math.round(n / MB)
    const growth = s.mbPerHour > 0 ? `${s.mbPerHour.toFixed(1)} MB/h` : 'N/A'
    return (
      `rss=${mb(s.rss)}MB heap=${mb(s.heapUsed)}MB/${mb(s.heapTotal)}MB ` +
      `ratio=${(s.heapRatio * 100).toFixed(0)}% growth=${growth}`
    )
  }

  /** 获取峰值 RSS */
  getPeakRss(): number {
    return this.maxRss
  }

  /** 获取采样历史 */
  getSamples(): readonly MemorySample[] {
    return this.samples
  }

  private recordSample(): void {
    const usage = process.memoryUsage()
    this.samples.push({
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      timestamp: Date.now(),
    })
    if (usage.rss > this.maxRss) {
      this.maxRss = usage.rss
    }

    // 限制采样数量（保留最近 120 个，约 1 小时 @ 30s）
    if (this.samples.length > 120) {
      this.samples = this.samples.slice(-60)
    }
  }

  private tick(): void {
    try {
      this.recordSample()
      const usage = process.memoryUsage()
      const heapStats = getHeapStatistics()

      // 检查 RSS 阈值
      if (usage.rss >= this.config.criticalThresholdRss) {
        logForDebugging(
          `[MemoryMonitor] CRITICAL: RSS=${Math.round(usage.rss / MB)}MB exceeds ` +
            `${Math.round(this.config.criticalThresholdRss / MB)}MB threshold`,
        )
        if (this.config.autoHeapDump && this.config.onHeapDump) {
          void this.config.onHeapDump().catch((err) => logError(err))
        }
        this.warnedRss = true
      } else if (
        usage.rss >= this.config.warnThresholdRss &&
        !this.warnedRss &&
        Date.now() > this.warningCooldown
      ) {
        logForDebugging(
          `[MemoryMonitor] WARNING: RSS=${Math.round(usage.rss / MB)}MB exceeds ` +
            `${Math.round(this.config.warnThresholdRss / MB)}MB threshold`,
        )
        this.warnedRss = true
        this.warningCooldown = Date.now() + 120_000 // 冷却 2 分钟
      } else if (usage.rss < this.config.warnThresholdRss * 0.8) {
        // 回落到安全区后重置警告状态
        this.warnedRss = false
      }

      // 检查堆使用率
      const heapRatio = usage.heapUsed / Math.max(heapStats.heap_size_limit, 1)
      if (heapRatio > this.config.warnHeapRatio) {
        logForDebugging(
          `[MemoryMonitor] Heap usage at ${(heapRatio * 100).toFixed(0)}% ` +
            `(${Math.round(usage.heapUsed / MB)}MB/${Math.round(usage.heapTotal / MB)}MB)`,
        )
      }

      // 检查 detached contexts（内存泄漏指标）
      if (heapStats.number_of_detached_contexts > 10) {
        logForDebugging(
          `[MemoryMonitor] ${heapStats.number_of_detached_contexts} detached V8 contexts detected`,
        )
      }
    } catch (err) {
      logError(err)
    }
  }
}

/** 全局单例 */
let globalMonitor: MemoryMonitor | null = null

/** 初始化全局内存监控 */
export function initMemoryMonitor(config?: Partial<MemoryMonitorConfig>): MemoryMonitor {
  if (!globalMonitor) {
    globalMonitor = new MemoryMonitor(config)
    globalMonitor.start()
  }
  return globalMonitor
}

/** 获取全局监控实例 */
export function getMemoryMonitor(): MemoryMonitor | null {
  return globalMonitor
}
