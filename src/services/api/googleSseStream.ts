import { LLMError } from '../../types/llm.js'
import type { GoogleGenerateContentResponse } from './conversions/google.js'

type GoogleSseResponse = GoogleGenerateContentResponse & {
  response?: GoogleGenerateContentResponse
  traceId?: string
  error?: { message?: string; code?: number }
}

/** Google 原生与 Code Assist 共用 SSE 解码；信封解包由调用方提供。 */
export async function* parseGoogleSseStream(
  body: ReadableStream<Uint8Array>,
  decode: (data: GoogleSseResponse) => GoogleGenerateContentResponse = (data) => data,
): AsyncGenerator<GoogleGenerateContentResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  function parseEvent(): GoogleGenerateContentResponse | undefined {
    const payload = dataLines.join('\n').trim()
    dataLines = []
    if (!payload || payload === '[DONE]') {
      return undefined
    }
    // 损坏的响应不可作为成功结束，否则会静默丢掉工具调用或输出。
    const data = JSON.parse(payload) as GoogleGenerateContentResponse & {
      error?: { message?: string; code?: number }
    }
    if (data.error) {
      throw new LLMError(data.error.message ?? payload, data.error.code)
    }
    return decode(data)
  }
  function consumeLine(line: string): GoogleGenerateContentResponse | undefined {
    if (line === '') {
      return parseEvent()
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    return undefined
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        const chunk = consumeLine(line)
        if (chunk) {
          yield chunk
        }
      }
      if (done) {
        break
      }
    }
    const finalLine = buffer.replace(/\r$/, '')
    const chunk = finalLine ? (consumeLine(finalLine) ?? parseEvent()) : parseEvent()
    if (chunk) {
      yield chunk
    }
  } finally {
    // 消费方提前返回时也关闭连接，避免背景持续消耗生成额度。
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
