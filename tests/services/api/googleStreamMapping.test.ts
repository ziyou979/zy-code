import { describe, expect, test } from 'bun:test'
import {
  googleStreamToStandard,
  type GoogleGenerateContentResponse,
} from '../../../src/services/api/conversions/google.js'
import type { LLMStreamEvent } from '../../../src/types/llm.js'

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

    const starts = events.filter((event) => event.type === 'chunk_start')
    expect(starts.map((event) => event.chunk.type)).toEqual(['thinking', 'tool_call', 'text'])
    expect(starts.map((event) => event.index)).toEqual([0, 1, 2])
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
})
