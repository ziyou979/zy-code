import { describe, expect, test } from 'bun:test'
import {
  normalizeMessagesForAPI,
  reorderMessagesInUI,
} from '../../../src/services/messages/apiNormalize.js'
import { stripCallerFieldFromAssistantMessage } from '../../../src/services/messages/prune.js'
import { addCacheBreakpoints } from '../../../src/services/api/messageTransforms.js'
import { buildGoogleRequestParams } from '../../../src/services/api/conversions/google.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../../src/services/messages/constructors.js'
import type { ToolCallBlock } from '../../../src/types/llm.js'
import { collapseReadSearchGroups } from '../../../src/services/compact/collapseReadSearch.js'

describe('apiNormalize', () => {
  test('正文后收到的思考摘要在 UI 显示到正文前，持久化内容和签名顺序不变', () => {
    const answer = createAssistantMessage({ content: 'fixture answer' })
    const thinking = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'fixture summary', signature: '' }],
    })
    thinking.message.id = answer.message.id
    thinking.thinkingDurationMs = 2780
    const signature = createAssistantMessage({
      content: [
        {
          type: 'text',
          text: '',
          providerMetadata: { googleThoughtSignature: 'tail-signature' },
        },
      ],
    })
    signature.message.id = answer.message.id
    const messages = [answer, thinking, signature]
    const before = JSON.stringify(messages)
    const displayed = reorderMessagesInUI(messages, [])
    expect(displayed).toEqual([thinking, answer, signature])
    expect(displayed[0]).toBe(thinking)
    expect(displayed[1]).toBe(answer)
    expect(displayed[2]).toBe(signature)
    expect(JSON.stringify(messages)).toBe(before)
    const collapsed = collapseReadSearchGroups(displayed, [])
    expect(collapsed[0]).toMatchObject({ type: 'collapsed_read_search', thinkingDurationMs: 2780 })
    expect(collapsed[1]).toBe(answer)
  })

  test('迟到的思考不跨越其他响应、用户输入或工具调用，原有思考在前顺序保持', () => {
    const answer = createAssistantMessage({ content: 'answer' })
    const thinking = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'summary', signature: '' }],
    })
    expect(reorderMessagesInUI([answer, thinking], [])).toEqual([answer, thinking])
    thinking.message.id = answer.message.id
    expect(reorderMessagesInUI([thinking, answer], [])).toEqual([thinking, answer])
    const user = createUserMessage({ content: [{ type: 'text', text: 'next turn' }] })
    expect(reorderMessagesInUI([answer, user, thinking], [])).toEqual([answer, user, thinking])
    const tool = createAssistantMessage({
      content: [{ type: 'tool_call', id: 'fixture-tool', name: 'Read', input: {} }],
    })
    tool.message.id = answer.message.id
    expect(reorderMessagesInUI([answer, tool, thinking], [])).toEqual([answer, tool, thinking])
  })

  test('Bash 签名经过会话序列化、工具字段清理和缓存转换后仍随原调用回传', () => {
    const block: ToolCallBlock & { caller: { type: string }; unexpectedField: string } = {
      type: 'tool_call',
      id: 'fixture-call',
      name: 'Bash',
      input: { command: 'echo fixture' },
      providerMetadata: {
        googleThoughtSignature: 'fixture-signature',
        anotherProviderField: 'preserved',
      },
      caller: { type: 'direct' },
      unexpectedField: 'remove',
    }
    const assistant = createAssistantMessage({ content: [block] })
    const original = JSON.parse(JSON.stringify(assistant)) as typeof assistant
    const messages = normalizeMessagesForAPI([
      createUserMessage({ content: [{ type: 'text', text: 'Run the fixture tool.' }] }),
      original,
      createUserMessage({
        content: [{ type: 'tool_result', toolCallId: block.id, content: 'fixture' }],
      }),
    ])
    const cleaned = messages.map((message) =>
      message.type === 'assistant' ? stripCallerFieldFromAssistantMessage(message) : message,
    )
    const cleanedBlock = cleaned.find((message) => message.type === 'assistant')?.message.content[0]
    expect(cleanedBlock).toMatchObject({ providerMetadata: block.providerMetadata })
    expect(cleanedBlock).not.toHaveProperty('caller')
    const request = buildGoogleRequestParams(
      { model: 'gemini-4-argon', maxTokens: 128, messages: addCacheBreakpoints(cleaned, true) },
      'json-schema',
    )
    expect(request.contents.find((content) => content.role === 'model')?.parts).toEqual([
      {
        functionCall: { id: block.id, name: 'Bash', args: block.input },
        thoughtSignature: 'fixture-signature',
      },
    ])
    expect(request.contents.at(-1)?.parts[0]?.functionResponse?.name).toBe('Bash')
    expect(original.message.content[0]).toHaveProperty('caller')
  })
  test('剥离 caller 时保留同一消息中每个工具调用各自的元数据', () => {
    const message = createAssistantMessage({
      content: [
        {
          type: 'tool_call',
          id: 'a',
          name: 'Bash',
          input: {},
          providerMetadata: { googleThoughtSignature: 'signature-a' },
          caller: { type: 'direct' },
        } as ToolCallBlock & { caller: { type: string } },
        {
          type: 'tool_call',
          id: 'b',
          name: 'Read',
          input: {},
          providerMetadata: { googleThoughtSignature: 'signature-b' },
        },
      ],
    })
    const result = stripCallerFieldFromAssistantMessage(message)
    expect(result.message.content).toEqual([
      {
        type: 'tool_call',
        id: 'a',
        name: 'Bash',
        input: {},
        providerMetadata: { googleThoughtSignature: 'signature-a' },
      },
      {
        type: 'tool_call',
        id: 'b',
        name: 'Read',
        input: {},
        providerMetadata: { googleThoughtSignature: 'signature-b' },
      },
    ])
  })
})
