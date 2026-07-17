import { describe, expect, test } from 'bun:test'
import type { Tools } from '../../../src/tools/tool.js'
import { selectDisplayMessages } from '../../../src/tools/AgentTool/UI.js'

// 构造最小化的 ProcessedMessage 用于测试
function makeToolCallMessage(name: string, id: string) {
  return {
    type: 'original' as const,
    message: {
      uuid: `uuid-${id}`,
      data: {
        message: {
          type: 'assistant' as const,
          message: {
            content: [{ type: 'tool_call', name, id }],
          },
        },
      },
    },
  }
}

function makeTextMessage(id: string) {
  return {
    type: 'original' as const,
    message: {
      uuid: `uuid-text-${id}`,
      data: {
        message: {
          type: 'assistant' as const,
          message: {
            content: [{ type: 'text', text: `some text ${id}` }],
          },
        },
      },
    },
  }
}

function makeSummaryMessage(id: string) {
  return {
    type: 'summary' as const,
    searchCount: 2,
    readCount: 1,
    replCount: 0,
    uuid: `summary-${id}`,
    isActive: false,
  }
}

// 模拟 Tools 数组：通过 name 和 briefStandalone 属性区分工具
const mockTools = [
  { name: 'Bash', briefStandalone: true },
  { name: 'Edit', briefStandalone: true },
  { name: 'Write', briefStandalone: true },
  { name: 'Read', briefStandalone: false },
  { name: 'Grep', briefStandalone: false },
] as unknown as Tools

describe('selectDisplayMessages', () => {
  test('消息数少于阈值时原样返回', () => {
    const messages = [makeToolCallMessage('Read', '1'), makeToolCallMessage('Grep', '2')]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)
    expect(result.displayed).toHaveLength(2)
    expect(result.hiddenCount).toBe(0)
  })

  test('briefStandalone 工具最后一次出现被保留在显示列表中', () => {
    // 10 条消息：Bash 在 index 1，后续都是 Read/Grep
    const messages = [
      makeToolCallMessage('Read', '0'),
      makeToolCallMessage('Bash', '1'), // briefStandalone，应被保留
      makeToolCallMessage('Read', '2'),
      makeToolCallMessage('Grep', '3'),
      makeToolCallMessage('Read', '4'),
      makeToolCallMessage('Grep', '5'),
      makeToolCallMessage('Read', '6'),
      makeToolCallMessage('Grep', '7'), // 最后 3 条
      makeToolCallMessage('Read', '8'),
      makeToolCallMessage('Grep', '9'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)

    // 应包含 Bash (index 1) + 最后 3 条 (index 7, 8, 9)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const uuids = result.displayed.map((m: any) =>
      m.type === 'original' ? m.message.uuid : m.uuid,
    )
    expect(uuids).toContain('uuid-1') // Bash 被豁免保留
    expect(uuids).toContain('uuid-7')
    expect(uuids).toContain('uuid-8')
    expect(uuids).toContain('uuid-9')
    expect(result.displayed.length).toBe(4)
  })

  test('每种 briefStandalone 工具只保留最后一次出现', () => {
    const messages = [
      makeToolCallMessage('Bash', '0'), // 第一次 Bash
      makeToolCallMessage('Read', '1'),
      makeToolCallMessage('Bash', '2'), // 第二次 Bash（应保留这个）
      makeToolCallMessage('Read', '3'),
      makeToolCallMessage('Grep', '4'),
      makeToolCallMessage('Read', '5'), // 最后 3 条
      makeToolCallMessage('Grep', '6'),
      makeToolCallMessage('Read', '7'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const uuids = result.displayed.map((m: any) =>
      m.type === 'original' ? m.message.uuid : m.uuid,
    )
    // 第二次 Bash (index 2) 被保留，第一次 (index 0) 不保留
    expect(uuids).toContain('uuid-2')
    expect(uuids).not.toContain('uuid-0')
  })

  test('不超过 MAX_BRIEF_STANDALONE_DISPLAY 上限', () => {
    // 构造 4 种不同的 briefStandalone 工具（超过上限 3）
    const toolsWithMany = [
      { name: 'Bash', briefStandalone: true },
      { name: 'Edit', briefStandalone: true },
      { name: 'Write', briefStandalone: true },
      { name: 'NotebookEdit', briefStandalone: true },
      { name: 'Read', briefStandalone: false },
    ] as unknown as Tools

    const messages = [
      makeToolCallMessage('Bash', '0'),
      makeToolCallMessage('Edit', '1'),
      makeToolCallMessage('Write', '2'),
      makeToolCallMessage('NotebookEdit', '3'), // 第 4 种，超过上限
      makeToolCallMessage('Read', '4'),
      makeToolCallMessage('Read', '5'),
      makeToolCallMessage('Read', '6'), // 最后 3 条
      makeToolCallMessage('Read', '7'),
      makeToolCallMessage('Read', '8'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, toolsWithMany)

    // 最后 3 条 + 最多 3 个 briefStandalone = 最多 6 条
    // NotebookEdit (index 3)、Write (index 2)、Edit (index 1) 从后往前扫描先命中
    // Bash (index 0) 超出上限不保留
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const uuids = result.displayed.map((m: any) =>
      m.type === 'original' ? m.message.uuid : m.uuid,
    )
    expect(uuids).not.toContain('uuid-0') // Bash 超出上限
  })

  test('显示结果按原始顺序排列', () => {
    const messages = [
      makeToolCallMessage('Read', '0'),
      makeToolCallMessage('Edit', '1'), // briefStandalone
      makeToolCallMessage('Read', '2'),
      makeToolCallMessage('Read', '3'),
      makeToolCallMessage('Read', '4'), // 最后 3 条
      makeToolCallMessage('Read', '5'),
      makeToolCallMessage('Read', '6'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const uuids = result.displayed.map((m: any) =>
      m.type === 'original' ? m.message.uuid : m.uuid,
    )
    // Edit (index 1) 应在最后 3 条 (index 4, 5, 6) 之前
    const editIdx = uuids.indexOf('uuid-1')
    const lastIdx = uuids.indexOf('uuid-4')
    expect(editIdx).toBeLessThan(lastIdx)
  })

  test('正确统计隐藏的 tool use 数量', () => {
    const messages = [
      makeToolCallMessage('Read', '0'), // 隐藏 (tool_call)
      makeTextMessage('1'), // 隐藏 (非 tool_call，不计入)
      makeToolCallMessage('Grep', '2'), // 隐藏 (tool_call)
      makeSummaryMessage('3'), // 隐藏 (summary，search+read>0)
      makeToolCallMessage('Read', '4'), // 最后 3 条
      makeToolCallMessage('Read', '5'),
      makeToolCallMessage('Read', '6'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)

    // 隐藏了 index 0 (tool_call)、1 (text, 不计)、2 (tool_call)、3 (summary)
    expect(result.hiddenCount).toBe(3) // 2 tool_call + 1 summary
  })

  test('briefStandalone 工具恰好在最后 3 条时不重复', () => {
    const messages = [
      makeToolCallMessage('Read', '0'),
      makeToolCallMessage('Read', '1'),
      makeToolCallMessage('Bash', '2'), // briefStandalone，也在最后 3 条
      makeToolCallMessage('Read', '3'),
      makeToolCallMessage('Read', '4'),
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = selectDisplayMessages(messages as any, mockTools)

    // Bash (index 2) 在最后 3 条 (index 2, 3, 4) 中，不会重复
    expect(result.displayed.length).toBe(3)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const uuids = result.displayed.map((m: any) =>
      m.type === 'original' ? m.message.uuid : m.uuid,
    )
    expect(uuids).toContain('uuid-2')
    expect(uuids).toContain('uuid-3')
    expect(uuids).toContain('uuid-4')
  })
})
