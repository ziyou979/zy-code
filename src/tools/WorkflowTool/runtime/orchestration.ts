import type { WorkflowSemaphore } from './concurrency.js'

/**
 * pipeline — 阶段间无 barrier，每项独立流过所有阶段。
 * 总耗时 = 最慢单项的阶段链之和。
 */
export async function pipeline<T>(
  items: T[],
  _semaphore: WorkflowSemaphore,
  ...stages: Array<(prevResult: any, originalItem: T, index: number) => any>
): Promise<any[]> {
  return Promise.all(
    items.map(async (item, index) => {
      let result: any = item
      for (const stage of stages) {
        try {
          result = await stage(result, item, index)
        } catch {
          return null
        }
        if (result === null) {
          return null
        }
      }
      return result
    }),
  )
}

/**
 * parallel — BARRIER 并发。等待所有 thunk 完成后返回。
 * 失败的 thunk → null（调用本身不会 reject）。
 */
export async function parallel(
  thunks: Array<() => Promise<any>>,
  _semaphore: WorkflowSemaphore,
): Promise<any[]> {
  const results = await Promise.allSettled(thunks.map((fn) => fn()))
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null))
}
