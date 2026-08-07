import { describe, expect, test } from 'bun:test'
import { syncVirtualMessageKeys } from '../../src/components/VirtualMessageList.js'

type TestMessage = { uuid: string }

const itemKey = (message: TestMessage) => `message-${message.uuid}`

describe('syncVirtualMessageKeys', () => {
  test('初次渲染非空列表时构建全部 key', () => {
    const messages = [{ uuid: 'first' }, { uuid: 'second' }]

    const keys = syncVirtualMessageKeys([], messages, messages, itemKey)

    expect(keys).toEqual(['message-first', 'message-second'])
  })

  test('纯追加时复用 key 数组并只添加新项', () => {
    const previous = [{ uuid: 'a' }, { uuid: 'b' }]
    const messages = [...previous, { uuid: 'c' }]
    const cachedKeys = previous.map(itemKey)

    const keys = syncVirtualMessageKeys(cachedKeys, previous, messages, itemKey)

    expect(keys).toBe(cachedKeys)
    expect(keys).toEqual(['message-a', 'message-b', 'message-c'])
  })

  test('折叠组尾部重组时重建索引并避免重复 key', () => {
    const previous = [{ uuid: 'stable' }, { uuid: 'collapsed-running' }]
    const messages = [previous[0]!, { uuid: 'collapsed-completed' }, { uuid: 'collapsed-running' }]
    const cachedKeys = previous.map(itemKey)

    const keys = syncVirtualMessageKeys(cachedKeys, previous, messages, itemKey)

    expect(keys).not.toBe(cachedKeys)
    expect(keys).toEqual([
      'message-stable',
      'message-collapsed-completed',
      'message-collapsed-running',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('同 UUID 的消息内容替换不重建稳定 key', () => {
    const previous = [{ uuid: 'a' }, { uuid: 'tool-result' }]
    const messages = [{ uuid: 'a' }, { uuid: 'tool-result' }]
    const cachedKeys = previous.map(itemKey)

    const keys = syncVirtualMessageKeys(cachedKeys, previous, messages, itemKey)

    expect(keys).toBe(cachedKeys)
  })

  test('清空或压缩列表时返回新的精确 key 数组', () => {
    const previous = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }]
    const messages = [{ uuid: 'summary' }]

    const keys = syncVirtualMessageKeys(previous.map(itemKey), previous, messages, itemKey)

    expect(keys).toEqual(['message-summary'])
  })
})
