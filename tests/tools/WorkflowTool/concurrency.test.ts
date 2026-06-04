import { describe, expect, test } from 'bun:test'
import { WorkflowSemaphore } from '../../../src/tools/WorkflowTool/runtime/concurrency.js'

describe('WorkflowSemaphore', () => {
  test('allows concurrent acquisitions up to capacity', async () => {
    const sem = new WorkflowSemaphore()
    const capacity = sem.getCapacity()

    const releases: Array<() => void> = []
    for (let i = 0; i < capacity; i++) {
      await sem.acquire()
      releases.push(() => sem.release())
    }

    // Next acquire should not resolve immediately
    let resolved = false
    const pending = sem.acquire().then(() => {
      resolved = true
    })

    // Give microtask queue a chance
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // Release one slot
    releases[0]!()
    await pending
    expect(resolved).toBe(true)

    // Cleanup
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
    // Agent count doesn't decrease — it's a lifetime counter
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

    // Cleanup
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
