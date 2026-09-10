import { describe, expect, test } from 'bun:test'
import {
  buildCodeAssistEnvelope,
  parseSseStream,
} from '../../../src/services/api/codeAssistProviderAdapter.js'
import {
  googleStreamToStandard,
  type GoogleGenerateContentResponse,
} from '../../../src/services/api/conversions/google.js'
import type { LLMStreamEvent } from '../../../src/types/llm.js'
import type { GoogleGenerateContentRequest } from '../../../src/services/api/conversions/google.js'

/** 构造一次性吐出全部文本的 SSE ReadableStream */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('buildCodeAssistEnvelope', () => {
  test('生成 {model, project, request} 信封', () => {
    const request: GoogleGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }
    const envelope = buildCodeAssistEnvelope('gemini-3.1-pro-preview', 'proj-1', request)
    expect(envelope.model).toBe('gemini-3.1-pro-preview')
    expect(envelope.project).toBe('proj-1')
    expect(envelope.request).toBe(request)
  })

  test('gemini-3 系列删除 maxOutputTokens（服务端管理输出预算）', () => {
    const request: GoogleGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
    }
    const envelope = buildCodeAssistEnvelope('gemini-3-pro-preview', 'proj-1', request)
    expect(envelope.request.generationConfig?.maxOutputTokens).toBeUndefined()
    expect(envelope.request.generationConfig?.temperature).toBe(0.5)
  })

  test('gemini-2.x 保留 maxOutputTokens', () => {
    const request: GoogleGenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }
    const envelope = buildCodeAssistEnvelope('gemini-2.5-flash', 'proj-1', request)
    expect(envelope.request.generationConfig?.maxOutputTokens).toBe(1024)
  })
})

describe('parseSseStream', () => {
  test('解析 data 行并忽略注释、空行与 [DONE]', async () => {
    const chunks: GoogleGenerateContentResponse[] = []
    const body = sseBody(
      [
        ': keep-alive comment',
        'data: {"candidates":[{"content":{"parts":[{"text":"he"}],"role":"model"}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[{"text":"llo"}],"role":"model"}}]}',
        'data: [DONE]',
      ].join('\n'),
    )
    for await (const chunk of parseSseStream(body)) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(2)
  })

  test('与 googleStreamToStandard 集成产出标准事件', async () => {
    const body = sseBody(
      [
        'data: {"responseId":"r1","candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}',
      ].join('\n'),
    )
    const events = await collect(googleStreamToStandard(parseSseStream(body), 'gemini-test'))

    expect(events[0]?.type).toBe('response_start')
    const textDelta = events.find(
      (event) => event.type === 'chunk_delta' && event.delta.type === 'text_delta',
    )
    expect(textDelta).toMatchObject({ delta: { type: 'text_delta', text: 'hello' } })
  })
})
