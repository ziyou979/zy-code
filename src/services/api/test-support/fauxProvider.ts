// 可编程的测试 mock provider。
// 注册到标准 LLMAdapter 接口，支持预设响应序列和流式模拟。
// 通过 QueryDeps 注入，无需 mock.module，消除跨文件缓存污染。

import { randomUUID } from 'node:crypto'
import type {
  ChunkDeltaEvent,
  ChunkStartEvent,
  ChunkStopEvent,
  CreateParams,
  DeltaUsage,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  ResponseDeltaEvent,
  ResponseStartEvent,
  ResponseStopEvent,
  StopReason,
  StreamResult,
  ToolDefinition,
} from '../../../types/llm.js'

// -- 响应预设类型

export interface FauxResponse {
  content: FauxContentBlock[]
  stopReason?: StopReason
  usage?: Partial<DeltaUsage>
  delayMs?: number
}

export type FauxContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown> }

// -- FauxProvider 实现

export class FauxProvider implements LLMAdapter {
  private queue: FauxResponse[]
  private callCount = 0

  constructor(responses: FauxResponse[]) {
    this.queue = [...responses]
  }

  get calls(): number {
    return this.callCount
  }

  get remaining(): number {
    return this.queue.length
  }

  async createStream(params: CreateParams, _signal: AbortSignal): Promise<StreamResult> {
    this.callCount++
    const response = this.queue.shift()
    if (!response) {
      throw new Error(`FauxProvider: 响应队列已耗尽（第 ${this.callCount} 次调用）`)
    }
    return {
      requestId: randomUUID(),
      response: undefined,
      stream: this.generateStream(response, randomUUID(), params.model),
    }
  }

  async createMessage(params: CreateParams, signal: AbortSignal): Promise<LLMResponse> {
    const { stream } = await this.createStream(params, signal)
    const content: LLMResponse['content'] = []
    let stopReason: StopReason = 'end_turn'
    let usage: DeltaUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }

    for await (const event of stream) {
      if (event.type === 'response_delta') {
        stopReason = event.stopReason
        if (event.usage) {
          usage = event.usage
        }
      }
    }

    return {
      id: randomUUID(),
      role: 'assistant' as const,
      content: [],
      stopReason,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      },
      model: params.model,
    }
  }

  async countTokens(_messages: LLMMessage[], _tools: ToolDefinition[]): Promise<number | null> {
    return null
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }

  private async *generateStream(
    response: FauxResponse,
    requestId: string,
    model: string,
  ): AsyncIterable<LLMStreamEvent> {
    if (response.delayMs) {
      await new Promise((r) => setTimeout(r, response.delayMs))
    }

    yield { type: 'response_start', responseId: requestId, model } as ResponseStartEvent

    let blockIndex = 0
    for (const block of response.content) {
      if (block.type === 'text') {
        yield {
          type: 'chunk_start',
          index: blockIndex,
          chunk: { type: 'text', text: '' },
        } as ChunkStartEvent
        yield {
          type: 'chunk_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: block.text },
        } as ChunkDeltaEvent
        yield { type: 'chunk_stop', index: blockIndex } as ChunkStopEvent
      } else if (block.type === 'thinking') {
        yield {
          type: 'chunk_start',
          index: blockIndex,
          chunk: { type: 'thinking', thinking: '', signature: '' },
        } as ChunkStartEvent
        yield {
          type: 'chunk_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        } as ChunkDeltaEvent
        yield { type: 'chunk_stop', index: blockIndex } as ChunkStopEvent
      } else if (block.type === 'tool_call') {
        const toolId = block.id ?? `call_${randomUUID().slice(0, 8)}`
        yield {
          type: 'chunk_start',
          index: blockIndex,
          chunk: { type: 'tool_call', id: toolId, name: block.name, input: {} },
        } as ChunkStartEvent
        yield {
          type: 'chunk_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partialJson: JSON.stringify(block.input) },
        } as ChunkDeltaEvent
        yield { type: 'chunk_stop', index: blockIndex } as ChunkStopEvent
      }
      blockIndex++
    }

    const usage: DeltaUsage = {
      inputTokens: response.usage?.inputTokens ?? 100,
      outputTokens: response.usage?.outputTokens ?? 50,
      cacheReadInputTokens: response.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: response.usage?.cacheCreationInputTokens ?? 0,
    }

    yield {
      type: 'response_delta',
      stopReason: response.stopReason ?? 'end_turn',
      usage,
    } as ResponseDeltaEvent

    yield { type: 'response_stop' } as ResponseStopEvent
  }
}

export function createFauxProvider(responses: FauxResponse[]): FauxProvider {
  return new FauxProvider(responses)
}
