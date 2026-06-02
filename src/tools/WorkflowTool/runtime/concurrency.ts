import { cpus } from 'node:os'

const MAX_AGENT_COUNT = 1000

export class WorkflowSemaphore {
  private available: number
  private readonly capacity: number
  private readonly waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private agentCount = 0
  private abortSignal: AbortSignal | undefined

  constructor(abortSignal?: AbortSignal) {
    this.capacity = Math.max(2, Math.min(16, cpus().length - 2))
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
