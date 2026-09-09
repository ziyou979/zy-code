import { describe, expect, test } from 'bun:test'
import { createAssistantMessage } from '../../../src/services/messages/constructors.js'
import { buildMessageLookups, scopeMessageLookups } from '../../../src/services/messages/lookups.js'

function row(id: string) {
  return createAssistantMessage({ content: [{ type: 'tool_call', id, name: 'Bash', input: {} }] })
}

describe('scopeMessageLookups', () => {
  test('保留当前工具及同级完成状态，不保留同级和无关工具载荷', () => {
    const first = row('first')
    const sibling = row('sibling')
    sibling.message.id = first.message.id
    const unrelated = row('other')
    const all = buildMessageLookups([first, sibling, unrelated], [first, sibling, unrelated])
    all.resolvedToolUseIDs.add('sibling')
    all.erroredToolUseIDs.add('first')
    all.inProgressHookCounts.set('first', new Map([['PostToolUse', 2]]))
    all.resolvedHookCounts.set('first', new Map([['PostToolUse', 1]]))
    all.toolResultByToolUseID.set('first', first)
    all.toolResultByToolUseID.set('sibling', sibling)
    const scoped = scopeMessageLookups(first, all)
    expect([...scoped.toolUseByToolUseID.keys()]).toEqual(['first'])
    expect([...scoped.toolResultByToolUseID.keys()]).toEqual(['first'])
    expect(scoped.siblingToolUseIDs.get('first')).toEqual(new Set(['first', 'sibling']))
    expect(scoped.resolvedToolUseIDs.has('sibling')).toBe(true)
    expect(scoped.erroredToolUseIDs.has('first')).toBe(true)
    expect(scoped.inProgressHookCounts.get('first')?.get('PostToolUse')).toBe(2)
    expect(scoped.resolvedHookCounts.get('first')?.get('PostToolUse')).toBe(1)
    expect(scoped.toolUseByToolUseID).not.toBe(all.toolUseByToolUseID)
  })

  test('保留历史行快照时，工具索引总量按行数线性增长', () => {
    const messages = Array.from({ length: 300 }, (_, i) => row(String(i)))
    const retained = messages.map((message, i) => {
      const history = messages.slice(0, i + 1)
      return scopeMessageLookups(message, buildMessageLookups(history, history))
    })
    expect(retained.reduce((sum, item) => sum + item.toolUseByToolUseID.size, 0)).toBe(300)
    expect(retained[0]!.toolUseByToolUseID.has('299')).toBe(false)
  })

  test('纯文本行没有工具载荷，组合行包含组内的全部工具', () => {
    const a = row('a')
    const b = row('b')
    const all = buildMessageLookups([a, b], [a, b])
    const text = createAssistantMessage({ content: 'hello' })
    expect(scopeMessageLookups(text, all).toolUseByToolUseID.size).toBe(0)
    const group = { ...a, type: 'grouped_tool_use' as const, toolName: 'Bash', messages: [a, b] }
    expect([...scopeMessageLookups(group, all).toolUseByToolUseID.keys()]).toEqual(['a', 'b'])
  })
})
