import { describe, expect, test } from 'bun:test'
import {
  googleStreamToStandard,
  type GoogleGenerateContentResponse,
} from '../../../src/services/api/conversions/google.js'
import type { LLMStreamEvent } from '../../../src/types/llm.js'
import {
  googleResponseToStandard,
  messagesToGoogle,
} from '../../../src/services/api/conversions/google.js'
import {
  sanitizeAssistantCompletionContent,
  validateAssistantCompletion,
} from '../../../src/services/api/assistantCompletionValidator.js'

async function* chunksToStream(
  chunks: GoogleGenerateContentResponse[],
): AsyncIterable<GoogleGenerateContentResponse> {
  yield* chunks
}

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('googleStreamToStandard', () => {
  test('思考与正文先后到达后，空签名尾包按原始块顺序提交', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          { candidates: [{ content: { parts: [{ text: 'summary', thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: 'answer' }] } }] },
          {
            candidates: [
              {
                content: { parts: [{ text: '', thoughtSignature: 'tail-signature' }] },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
        'gemini-4-argon',
        'delta',
      ),
    )
    expect(
      events.filter((event) => event.type === 'chunk_start').map((event) => event.chunk.type),
    ).toEqual(['thinking', 'text', 'text'])
    expect(
      events.filter((event) => event.type === 'chunk_stop').map((event) => event.index),
    ).toEqual([0, 1, 2])
  })

  test('空文本签名尾包不丢失、不合并到前一无签名 Part', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          { candidates: [{ content: { parts: [{ text: 'OK' }] } }] },
          {
            candidates: [
              {
                content: { parts: [{ text: '', thoughtSignature: 'tail-signature' }] },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
        'gemini-4-argon',
        'delta',
      ),
    )
    expect(
      events.filter((event) => event.type === 'chunk_start').map((event) => event.index),
    ).toEqual([0, 1])
    expect(events.filter((event) => event.type === 'chunk_stop')).toEqual([
      { type: 'chunk_stop', index: 0 },
      {
        type: 'chunk_stop',
        index: 1,
        extras: { providerMetadata: { googleThoughtSignature: 'tail-signature' } },
      },
    ])
    const response = googleResponseToStandard(
      {
        candidates: [
          {
            content: { parts: [{ text: 'OK' }, { text: '', thoughtSignature: 'tail-signature' }] },
            finishReason: 'STOP',
          },
        ],
      },
      'gemini-4-argon',
    )
    const content = sanitizeAssistantCompletionContent(response.content)
    expect(messagesToGoogle([{ role: 'assistant', content }]).contents[0]?.parts).toEqual([
      { text: 'OK' },
      { text: '', thoughtSignature: 'tail-signature' },
    ])
    expect(
      validateAssistantCompletion({ content: content.slice(1), stopReason: 'end_turn' }).ok,
    ).toBe(false)
    const signed = {
      type: 'text' as const,
      text: '  <think>literal</think> OK\n',
      providerMetadata: { googleThoughtSignature: 'signed-text' },
    }
    expect(sanitizeAssistantCompletionContent([signed])).toEqual([signed])
  })
  test('工具完整响应前断线不产出可执行工具，尾包签名更新在完成后才释放', async () => {
    async function* interrupted() {
      yield {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'Bash', id: 'a', args: { command: 'fixture' } } }],
            },
          },
        ],
      }
      throw new Error('connection lost')
    }
    const events: LLMStreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of googleStreamToStandard(
          interrupted(),
          'gemini-4-argon',
          'delta',
        )) {
          events.push(event)
        }
      })(),
    ).rejects.toThrow('connection lost')
    expect(
      events.some((event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call'),
    ).toBe(false)
    const completed = await collect(
      googleStreamToStandard(
        chunksToStream([
          {
            candidates: [
              { content: { parts: [{ functionCall: { name: 'Bash', id: 'a', args: {} } }] } },
            ],
          },
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'Bash', id: 'a', args: { command: 'fixture' } },
                      thoughtSignature: 'late-signature',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
        'gemini-4-argon',
        'delta',
      ),
    )
    expect(completed.find((event) => event.type === 'chunk_start')).toMatchObject({
      chunk: { providerMetadata: { googleThoughtSignature: 'late-signature' } },
    })
    expect(completed.find((event) => event.type === 'chunk_delta')).toMatchObject({
      delta: { partialJson: '{"command":"fixture"}' },
    })
  })
  test('工具参数截断或未支持的参数分片均不执行工具', async () => {
    for (const chunk of [
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'Bash', args: { command: 'partial' } } }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'Bash', willContinue: true } }] } },
        ],
      },
    ]) {
      const events: LLMStreamEvent[] = []
      await expect(
        (async () => {
          for await (const event of googleStreamToStandard(
            chunksToStream([chunk]),
            'gemini-4-argon',
            'delta',
          )) {
            events.push(event)
          }
        })(),
      ).rejects.toThrow()
      expect(
        events.some((event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call'),
      ).toBe(false)
    }
  })
  test('独立用量包不会清空之前的输入或输出计数，思考计数保留', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          {
            candidates: [{ content: { parts: [{ text: 'OK' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
          },
          { candidates: [{ finishReason: 'STOP' }], usageMetadata: { thoughtsTokenCount: 3 } },
        ]),
        'gemini-4-argon',
        'delta',
      ),
    )
    expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, extras: { thoughtsTokenCount: 3 } },
    })
  })
  test('安全拦截反馈作为 content_filter 完成，不误判断线重试', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4 } },
        ]),
        'gemini-4-argon',
        'delta',
      ),
    )
    expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
      stopReason: 'content_filter',
      usage: { inputTokens: 4 },
    })
  })
  test('独立完成包与尾部用量包都转换，且正常关闭文本块', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
          { candidates: [{ finishReason: 'STOP' }] },
          { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
        ]),
        'gemini-test',
        'delta',
      ),
    )
    expect(events.filter((event) => event.type === 'chunk_stop')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'response_delta')).toEqual([
      {
        type: 'response_delta',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ])
    expect(events.at(-1)?.type).toBe('response_stop')
  })
  test('thinking、tool_call 与尾部 text 使用互不冲突的 index', async () => {
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          {
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: 'think' },
                    { functionCall: { id: 'call_1', name: 'Bash', args: { command: 'pwd' } } },
                    { text: '\n' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
        'gemini-test',
      ),
    )

    const starts = events
      .filter((event) => event.type === 'chunk_start')
      .sort((a, b) => a.index - b.index)
    expect(starts.map((event) => event.chunk.type)).toEqual(['thinking', 'tool_call', 'text'])
    expect(starts.map((event) => event.index)).toEqual([0, 1, 2])
    expect(
      events.filter((event) => event.type === 'chunk_stop').map((event) => event.index),
    ).toEqual([0, 1, 2])
    expect(events.find((event) => event.type === 'response_delta')).toMatchObject({
      stopReason: 'tool_use',
    })
  })

  test('累计快照不会重复发出同一个工具调用', async () => {
    const toolPart = {
      functionCall: { id: 'call_1', name: 'Read', args: { file_path: 'a.ts' } },
    }
    const events = await collect(
      googleStreamToStandard(
        chunksToStream([
          { candidates: [{ content: { parts: [toolPart] } }] },
          { candidates: [{ content: { parts: [toolPart] }, finishReason: 'STOP' }] },
        ]),
        'gemini-test',
      ),
    )

    const toolStarts = events.filter(
      (event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call',
    )
    expect(toolStarts).toHaveLength(1)
  })

  test('蛇形 thought_signature 及嵌套在 functionCall 内部的思考签名可正确捕获', async () => {
    const rawChunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_snake_1',
                    name: 'default_api:Read',
                    args: { file_path: 'test.txt' },
                    thought_signature: 'snake_sig_123',
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ] as unknown as GoogleGenerateContentResponse[]

    const events = await collect(googleStreamToStandard(chunksToStream(rawChunks), 'gemini-test'))

    const toolStart = events.find(
      (event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call',
    )
    expect(toolStart).toMatchObject({
      chunk: {
        type: 'tool_call',
        providerMetadata: { googleThoughtSignature: 'snake_sig_123' },
      },
    })
  })

  test('流式中 thinking 块先到达时，后续无签名的 functionCall chunk 自动继承思考签名', async () => {
    const rawChunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: 'analyzing...',
                  thought_signature: 'stream_thinking_sig_456',
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_inherited_1',
                    name: 'default_api:Read',
                    args: { file_path: 'inherited.txt' },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ] as unknown as GoogleGenerateContentResponse[]

    const events = await collect(googleStreamToStandard(chunksToStream(rawChunks), 'gemini-test'))

    const toolStart = events.find(
      (event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call',
    )
    expect(toolStart).toMatchObject({
      chunk: {
        type: 'tool_call',
        providerMetadata: { googleThoughtSignature: 'stream_thinking_sig_456' },
      },
    })
  })
  test('跨响应重复的 Vertex 调用 ID 映射为本地唯一 ID，回传时还原原始 ID 与签名', async () => {
    const response = (sig: string, name: string) =>
      chunksToStream([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: 'call_dup', name, args: {} }, thoughtSignature: sig },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ])
    const toolOf = async (sig: string, name: string) => {
      const events = await collect(
        googleStreamToStandard(response(sig, name), 'gemini-4-argon', 'delta'),
      )
      const start = events.find(
        (event) => event.type === 'chunk_start' && event.chunk.type === 'tool_call',
      )
      if (start?.type !== 'chunk_start' || start.chunk.type !== 'tool_call') {
        throw new Error('missing tool_call')
      }
      return { ...start.chunk, input: {} }
    }
    const first = await toolOf('sig-read', 'Read')
    const second = await toolOf('sig-glob', 'Glob')
    expect(first.id).not.toBe(second.id)
    expect(second.providerMetadata).toEqual({
      googleThoughtSignature: 'sig-glob',
      googleFunctionCallId: 'call_dup',
    })

    const { contents } = messagesToGoogle([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [first] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: first.id, content: 'A' }] },
      { role: 'assistant', content: [second] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: second.id, content: 'B' }] },
    ])
    expect(contents[3]?.parts[0]).toMatchObject({
      thoughtSignature: 'sig-glob',
      functionCall: { id: 'call_dup', name: 'Glob' },
    })
    expect(contents[4]?.parts[0]?.functionResponse).toMatchObject({ id: 'call_dup', name: 'Glob' })
  })

  test('非流式响应同样为工具调用分配本地 ID 并保留原始调用 ID', () => {
    const response = googleResponseToStandard(
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { id: 'call_dup', name: 'Read', args: {} } }] },
            finishReason: 'STOP',
          },
        ],
      },
      'gemini-4-argon',
    )
    const tool = response.content[0]
    expect(tool).toMatchObject({
      type: 'tool_call',
      providerMetadata: { googleFunctionCallId: 'call_dup' },
    })
    expect(tool?.type === 'tool_call' && tool.id).not.toBe('call_dup')
  })
})
