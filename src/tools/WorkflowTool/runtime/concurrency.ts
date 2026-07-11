import { cpus } from 'node:os'

const MAX_AGENT_COUNT = 1000

/**
 * 根据 workflowSize 建议计算合适的并行度。
 * CC dynamicWorkflowSize 映射：
 * - small:   2×CPU（保守，适合文件操作/审查）
 * - medium:  4×CPU（默认，适合一般编排）
 * - large:   8×CPU（激进，适合大规模迁移/审计）
 * 默认行为同 medium。
 */
function getCapacityForSize(size?: 'small' | 'medium' | 'large' | null): number {
  const cpuCount = Math.max(1, cpus().length - 2)
  switch (size) {
    case 'small':
      return Math.max(2, cpuCount * 2)
    case 'large':
      return Math.max(2, cpuCount * 8)
    case 'medium':
    default:
      return Math.max(2, cpuCount * 4)
  }
}

export class WorkflowSemaphore {
  private available: number
  private readonly capacity: number
  private readonly waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private agentCount = 0
  private abortSignal: AbortSignal | undefined

  constructor(
    abortSignal?: AbortSignal,
    workflowSize?: 'small' | 'medium' | 'large' | null,
  ) {
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
