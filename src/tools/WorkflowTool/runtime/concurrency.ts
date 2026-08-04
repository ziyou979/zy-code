import { cpus } from 'node:os'

const MAX_AGENT_COUNT = 1000
const MAX_CONCURRENT_AGENTS = 16

const WORKFLOW_SIZE_CONCURRENCY_LIMITS = {
  small: 4,
  medium: 14,
  large: MAX_CONCURRENT_AGENTS,
} as const

/**
 * 根据 CPU 与 workflowSize 建议计算并行度。
 *
 * Claude Code 2.1.220 的硬上限是 min(16, CPU - 2)；size 只进一步收紧
 * 小/中型 workflow，避免提示建议少于 5/15 个 agent，但运行时却同时启动更多。
 * large 仍受 16 的硬上限约束，防止高核数机器在一次 fan-out 中放大内存峰值。
 */
function getCapacityForSize(size?: 'small' | 'medium' | 'large' | null): number {
  const cpuCapacity = Math.max(1, cpus().length - 2)
  const hardCapacity = Math.min(MAX_CONCURRENT_AGENTS, cpuCapacity)
  // null 对应配置中的 unrestricted；undefined 才采用默认 medium。
  if (size === null) {
    return hardCapacity
  }
  const effectiveSize = size ?? 'medium'
  return Math.min(hardCapacity, WORKFLOW_SIZE_CONCURRENCY_LIMITS[effectiveSize])
}

export class WorkflowSemaphore {
  private available: number
  private readonly capacity: number
  private readonly waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private agentCount = 0
  private abortSignal: AbortSignal | undefined

  constructor(abortSignal?: AbortSignal, workflowSize?: 'small' | 'medium' | 'large' | null) {
    this.capacity = getCapacityForSize(workflowSize)
    this.available = this.capacity
    this.abortSignal = abortSignal
  }

  async acquire(): Promise<void> {
    if (this.abortSignal?.aborted) {
      throw new Error('Workflow aborted')
    }
    if (this.agentCount >= MAX_AGENT_COUNT) {
      throw new Error(
        `Workflow agent limit reached (${MAX_AGENT_COUNT}). This is a runaway-loop backstop.`,
      )
    }
    this.agentCount++

    if (this.available > 0) {
      this.available--
      return
    }

    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject }
      this.waitQueue.push(entry)

      if (this.abortSignal) {
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(entry)
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1)
            reject(new Error('Workflow aborted'))
          }
        }
        this.abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  release(): void {
    const next = this.waitQueue.shift()
    if (next) {
      next.resolve()
    } else {
      this.available = Math.min(this.available + 1, this.capacity)
    }
  }

  getAgentCount(): number {
    return this.agentCount
  }

  getCapacity(): number {
    return this.capacity
  }

  abortAllWaiting(): void {
    const err = new Error('Workflow aborted')
    for (const entry of this.waitQueue) {
      entry.reject(err)
    }
    this.waitQueue.length = 0
  }
}
