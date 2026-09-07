import { describe, expect, test } from 'bun:test'
import { createFileStateCacheWithSizeLimit } from '../../src/services/file-persistence/fileStateCache.js'
import { QueryGuard } from '../../src/services/query/queryGuard.js'
import { createReplStore } from '../../src/state/ReplStore.js'

function createTestStore() {
  return createReplStore({
    initialExternalLoading: false,
    queryGuard: new QueryGuard(),
    titleGenerationAttempted: false,
    readFileState: createFileStateCacheWithSizeLimit(10),
    contentReplacementState: null,
    initialInputValue: '',
  })
}

describe('ReplStore 输入通道', () => {
  test('输入更新不会通知主状态订阅者', () => {
    const store = createTestStore()
    let replNotificationCount = 0
    let inputNotificationCount = 0
    const unsubscribeRepl = store.subscribe(() => replNotificationCount++)
    const unsubscribeInput = store.input.subscribe(() => inputNotificationCount++)

    store.input.setValue('hello')

    expect(store.input.getValue()).toBe('hello')
    expect(inputNotificationCount).toBe(1)
    expect(replNotificationCount).toBe(0)

    unsubscribeInput()
    unsubscribeRepl()
  })

  test('重复输入值不会产生额外通知', () => {
    const store = createTestStore()
    let inputNotificationCount = 0
    const unsubscribe = store.input.subscribe(() => inputNotificationCount++)

    store.input.setValue('same')
    store.input.setValue('same')

    expect(inputNotificationCount).toBe(1)
    unsubscribe()
  })
})
