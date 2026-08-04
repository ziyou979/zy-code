import { describe, expect, test } from 'bun:test'
import { WorkflowSemaphore } from '../../../src/tools/WorkflowTool/runtime/concurrency.js'
import { parallel, pipeline } from '../../../src/tools/WorkflowTool/runtime/orchestration.js'

describe('orchestration', () => {
  describe('pipeline', () => {
    test('passes items through stages', async () => {
      const sem = new WorkflowSemaphore()
      const result = await pipeline(
        [1, 2, 3],
        sem,
        (item) => (item as number) * 2,
        (item) => (item as number) + 1,
      )
      expect(result).toEqual([3, 5, 7])
    })

    test('stage error makes item null and skips remaining', async () => {
      const sem = new WorkflowSemaphore()
      const result = await pipeline(
        [1, 2, 3],
        sem,
        (item) => {
          if (item === 2) throw new Error('boom')
          return item
        },
        (item) => (item as number) * 10,
      )
      expect(result).toEqual([10, null, 30])
    })

    test('provides originalItem and index to later stages', async () => {
      const sem = new WorkflowSemaphore()
      const result = await pipeline(
        ['a', 'b'],
        sem,
        (item) => (item as string).toUpperCase(),
        (prev, original, idx) => `${prev}-${original}-${idx}`,
      )
      expect(result).toEqual(['A-a-0', 'B-b-1'])
    })

    test('empty items returns empty array', async () => {
      const sem = new WorkflowSemaphore()
      const result = await pipeline([], sem, (x) => x)
      expect(result).toEqual([])
    })

    test('超过 4096 项时显式拒绝', async () => {
      const sem = new WorkflowSemaphore()

      await expect(pipeline(new Array(4097).fill(0), sem, (x) => x)).rejects.toThrow(
        'pipeline accepts at most 4096 items',
      )
    })
  })

  describe('parallel', () => {
    test('runs all thunks and collects results', async () => {
      const sem = new WorkflowSemaphore()
      const result = await parallel(
        [() => Promise.resolve('a'), () => Promise.resolve('b'), () => Promise.resolve('c')],
        sem,
      )
      expect(result).toEqual(['a', 'b', 'c'])
    })

    test('failed thunk becomes null', async () => {
      const sem = new WorkflowSemaphore()
      const result = await parallel(
        [
          () => Promise.resolve('ok'),
          () => Promise.reject(new Error('fail')),
          () => Promise.resolve('also ok'),
        ],
        sem,
      )
      expect(result).toEqual(['ok', null, 'also ok'])
    })

    test('empty thunks returns empty array', async () => {
      const sem = new WorkflowSemaphore()
      const result = await parallel([], sem)
      expect(result).toEqual([])
    })

    test('超过 4096 个 thunk 时显式拒绝', async () => {
      const sem = new WorkflowSemaphore()
      const thunks = new Array(4097).fill(null).map(() => () => Promise.resolve(null))

      await expect(parallel(thunks, sem)).rejects.toThrow('parallel accepts at most 4096 items')
    })
  })
})
