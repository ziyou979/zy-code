import { describe, expect, test } from 'bun:test'
import { cpus } from 'node:os'
import { WorkflowSemaphore } from '../../../src/tools/WorkflowTool/runtime/concurrency.js'

describe('WorkflowSemaphore', () => {
  test('按 2.1.220 上限约束默认和显式规模的并发数', () => {
    const hardCapacity = Math.min(16, Math.max(1, cpus().length - 2))

    expect(new WorkflowSemaphore().getCapacity()).toBe(Math.min(hardCapacity, 14))
    expect(new WorkflowSemaphore(undefined, 'small').getCapacity()).toBe(Math.min(hardCapacity, 4))
    expect(new WorkflowSemaphore(undefined, 'medium').getCapacity()).toBe(
      Math.min(hardCapacity, 14),
    )
    expect(new WorkflowSemaphore(undefined, 'large').getCapacity()).toBe(hardCapacity)
    expect(new WorkflowSemaphore(undefined, null).getCapacity()).toBe(hardCapacity)
  })

  test('allows concurrent acquisitions up to capacity', async () => {
    const sem = new WorkflowSemaphore()
    const capacity = sem.getCapacity()

    const releases: Array<() => void> = []
    for (let i = 0; i < capacity; i++) {
      await sem.acquire()
      releases.push(() => sem.release())
    }

    // 下一次 acquire 不应立即完成
    let resolved = false
    const pending = sem.acquire().then(() => {
      resolved = true
    })

    // 给微任务队列一次执行机会
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // 释放一个并发槽位
    releases[0]!()
    await pending
    expect(resolved).toBe(true)

    // 清理
    sem.release()
    releases.slice(1).forEach((r) => r())
  })

  test('tracks agent count', async () => {
    const sem = new WorkflowSemaphore()
    expect(sem.getAgentCount()).toBe(0)

    await sem.acquire()
    expect(sem.getAgentCount()).toBe(1)

    await sem.acquire()
    expect(sem.getAgentCount()).toBe(2)

    sem.release()
    sem.release()
    // Agent 数量不会减少——这是生命周期累计值
    expect(sem.getAgentCount()).toBe(2)
  })

  test('abortAllWaiting rejects queued acquisitions', async () => {
    const sem = new WorkflowSemaphore()
    const capacity = sem.getCapacity()

    for (let i = 0; i < capacity; i++) {
      await sem.acquire()
    }

    let error: Error | null = null
    const pending = sem.acquire().catch((e) => {
      error = e
    })

    sem.abortAllWaiting()
    await pending

    expect(error).not.toBeNull()
    expect(error!.message).toBe('Workflow aborted')

    // 清理
    for (let i = 0; i < capacity; i++) sem.release()
  })

  test('respects abort signal', async () => {
    const controller = new AbortController()
    const sem = new WorkflowSemaphore(controller.signal)

    controller.abort()

    let error: Error | null = null
    try {
      await sem.acquire()
    } catch (e: unknown) {
      error = e as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toBe('Workflow aborted')
  })
})
