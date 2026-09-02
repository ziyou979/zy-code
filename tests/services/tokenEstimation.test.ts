import { describe, expect, it } from 'bun:test'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForBlock,
  roughTokenCountEstimationForMessage,
  roughTokenCountEstimationForMessages,
} from '../../src/services/tokenEstimation.js'
import { estimateMessageTokens } from '../../src/services/compact/microCompact.js'
import type { Message } from '../../src/types/message.js'
import type { ContentBlock } from '../../src/types/llm.js'

// 4 字节/token 的估算基准：roughTokenCountEstimation('abcd') === 1
const T = (s: string) => roughTokenCountEstimation(s)
// ContentBlock 是判别联合，测试字面量对象通过 unknown 转义类型完备性检查
const asBlock = (b: Record<string, unknown>) => b as unknown as ContentBlock

describe('roughTokenCountEstimationForBlock - block 级估算收敛点', () => {
  it('text block 按文本长度估算', () => {
    const text = 'hello world'
    expect(roughTokenCountEstimationForBlock(asBlock({ type: 'text', text }))).toBe(T(text))
  })

  it('image/document block 固定 2000（与 microCompact 原常量一致）', () => {
    expect(roughTokenCountEstimationForBlock(asBlock({ type: 'image' }))).toBe(2000)
    expect(roughTokenCountEstimationForBlock(asBlock({ type: 'document' }))).toBe(2000)
  })

  it('tool_call block 统计 name + input', () => {
    const block = asBlock({ type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect(roughTokenCountEstimationForBlock(block)).toBe(T('Bash{"command":"ls"}'))
  })

  it('tool_result 字符串 content 按文本估算', () => {
    const block = asBlock({ type: 'tool_result', toolCallId: 't1', content: 'output text' })
    expect(roughTokenCountEstimationForBlock(block)).toBe(T('output text'))
  })

  it('tool_result 数组 content 递归统计（含 image 子块）', () => {
    const block = asBlock({
      type: 'tool_result',
      toolCallId: 't1',
      content: [{ type: 'text', text: 'some text' }, { type: 'image' }],
    })
    expect(roughTokenCountEstimationForBlock(block)).toBe(T('some text') + 2000)
  })

  it('thinking block 只统计 thinking 文本', () => {
    const block = asBlock({ type: 'thinking', thinking: 'deep thoughts', signature: 'sig' })
    expect(roughTokenCountEstimationForBlock(block)).toBe(T('deep thoughts'))
  })
})

describe('roughTokenCountEstimationForMessage - 消息级估算收敛点', () => {
  it('assistant 消息统计其内容块', () => {
    const message = {
      type: 'assistant',
      message: { content: [asBlock({ type: 'text', text: 'assistant text' })] },
    }
    expect(roughTokenCountEstimationForMessage(message)).toBe(T('assistant text'))
  })

  it('user 消息统计其内容块', () => {
    const message = {
      type: 'user',
      message: { content: [asBlock({ type: 'text', text: 'user text' })] },
    }
    expect(roughTokenCountEstimationForMessage(message)).toBe(T('user text'))
  })

  it('非 user/assistant 类型返回 0', () => {
    expect(roughTokenCountEstimationForMessage({ type: 'system' })).toBe(0)
  })
})

// 构造一个最小可用的 Message（满足 UserMessage / AssistantMessage 结构）
function userMsg(content: unknown[]): Message {
  return {
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'user', content },
  } as unknown as Message
}

function assistantMsg(content: unknown[]): Message {
  return {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { content },
  } as unknown as Message
}

describe('estimateMessageTokens - microCompact 收敛后保持 4/3 保守系数', () => {
  it('等于 roughTokenCountEstimationForMessages × 4/3 向上取整', () => {
    const messages = [userMsg([{ type: 'text', text: 'hello world' }])]
    const expected = Math.ceil(roughTokenCountEstimationForMessages(messages as never) * (4 / 3))
    expect(estimateMessageTokens(messages)).toBe(expected)
  })

  it('text 消息估算', () => {
    const messages = [assistantMsg([{ type: 'text', text: 'a'.repeat(40) }])]
    // 40 字符 / 4 = 10 token，×4/3 → ceil(13.33) = 14
    expect(estimateMessageTokens(messages)).toBe(14)
  })

  it('tool_call + tool_result 混合消息', () => {
    const messages = [
      assistantMsg([{ type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      userMsg([
        {
          type: 'tool_result',
          toolCallId: 't1',
          content: 'result of command'.repeat(10),
        },
      ]),
    ]
    const expected = Math.ceil(roughTokenCountEstimationForMessages(messages as never) * (4 / 3))
    expect(estimateMessageTokens(messages)).toBe(expected)
  })

  it('image block 计 2000 并乘 4/3', () => {
    const messages = [userMsg([{ type: 'image' }])]
    expect(estimateMessageTokens(messages)).toBe(Math.ceil(2000 * (4 / 3)))
  })

  it('空消息列表返回 0', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })
})
