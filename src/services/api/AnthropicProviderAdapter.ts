/**
 * Anthropic Provider Adapter — 将标准消息格式转换为 Anthropic SDK 格式。
 *
 * 此文件是唯一引用 @anthropic-ai/sdk 类型的 adapter。
 * 调用方只使用 StandardMessageFormat 中的类型。
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaContentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import type {
  StandardMessage,
  StandardMessageRequest,
  StandardResponse,
  StandardStreamEvent,
  StandardContentBlock,
  StandardToolDefinition,
  StandardUsage,
  StandardStopReason,
} from './StandardMessageFormat.js'
import { getLLMClient } from './client.js'
import { getAPIProvider } from '../../utils/model/providers.js'

// ============================================================================
// 标准格式 → Anthropic 格式
// ============================================================================

function standardMessagesToAnthropic(
  messages: StandardMessage[],
): MessageParam[] {
  return messages
    .filter((m): m is Extract<StandardMessage, { role: 'user' | 'assistant' }> => m.role !== 'system')
    .map((msg) => ({
      role: msg.role,
      content: standardContentToAnthropic(msg.content),
    })) as unknown as MessageParam[]
}

function standardContentToAnthropic(
  content: string | StandardContentBlock[],
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map(standardBlockToAnthropic)
}

function standardBlockToAnthropic(block: StandardContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType,
          data: block.data,
        },
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: typeof block.content === 'string'
          ? block.content
          : block.content.map(standardBlockToAnthropic),
        is_error: block.isError ?? false,
      }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature && { signature: block.signature }),
      }
  }
}

function standardToolsToAnthropic(
  tools?: StandardToolDefinition[],
): BetaToolUnion[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  })) as unknown as BetaToolUnion[]
}

// ============================================================================
// Anthropic 格式 → 标准格式
// ============================================================================

function anthropicResponseToStandard(
  response: BetaMessage,
): StandardResponse {
  return {
    id: response.id,
    model: response.model,
    role: 'assistant',
    content: response.content.map(anthropicBlockToStandard),
    stopReason: anthropicStopReasonToStandard(response.stop_reason),
    usage: anthropicUsageToStandard(response.usage as unknown as Record<string, unknown>),
  }
}

function anthropicBlockToStandard(block: BetaContentBlock): StandardContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: (block as any).input ?? {},
    }
  }
  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: (block as any).thinking ?? '',
      signature: (block as any).signature,
    }
  }
  // 兜底：未知类型当文本处理
  return { type: 'text', text: JSON.stringify(block) }
}

function anthropicStopReasonToStandard(
  reason: string | null,
): StandardStopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn'
    case 'max_tokens': return 'max_tokens'
    case 'stop_sequence': return 'stop_sequence'
    case 'tool_use': return 'tool_use'
    default: return null
  }
}

function anthropicUsageToStandard(usage: Record<string, unknown>): StandardUsage {
  return {
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheReadTokens: (usage.cache_read_input_tokens as number) ?? 0,
    cacheWriteTokens: (usage.cache_creation_input_tokens as number) ?? 0,
  }
}

function anthropicStreamEventToStandard(
  event: BetaRawMessageStreamEvent,
): StandardStreamEvent | null {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        messageId: event.message.id,
        model: event.message.model,
      }

    case 'content_block_start': {
      const block = event.content_block as unknown as Record<string, unknown>
      let contentBlock: StandardContentBlock
      if (block.type === 'text') {
        contentBlock = { type: 'text', text: (block.text as string) ?? '' }
      } else if (block.type === 'tool_use') {
        contentBlock = {
          type: 'tool_use',
          id: (block.id as string) ?? '',
          name: (block.name as string) ?? '',
          input: (block.input as Record<string, unknown>) ?? {},
        }
      } else if (block.type === 'thinking') {
        contentBlock = {
          type: 'thinking',
          thinking: (block.thinking as string) ?? '',
          signature: block.signature as string | undefined,
        }
      } else {
        return null // 跳过未知类型
      }
      return {
        type: 'content_block_start',
        index: event.index,
        contentBlock,
      }
    }

    case 'content_block_delta': {
      const delta = event.delta as unknown as Record<string, unknown>
      if (delta.type === 'text_delta') {
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'text', text: (delta.text as string) ?? '' },
        }
      }
      if (delta.type === 'thinking_delta') {
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'thinking', thinking: (delta.thinking as string) ?? '' },
        }
      }
      if (delta.type === 'input_json_delta') {
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'input_json', partialJson: (delta.partial_json as string) ?? '' },
        }
      }
      return null
    }

    case 'content_block_stop':
      return {
        type: 'content_block_stop',
        index: event.index,
      }

    case 'message_delta':
      return {
        type: 'message_delta',
        stopReason: anthropicStopReasonToStandard(
          (event.delta as any)?.stop_reason ?? null,
        ),
        usage: event.usage ? anthropicUsageToStandard(event.usage as unknown as Record<string, unknown>) : undefined,
      }

    default:
      return null
  }
}

// ============================================================================
// Provider 实现
// ============================================================================

export class AnthropicProviderAdapter {
  readonly name = 'anthropic'

  private client: Anthropic | null = null

  private async getClient(model?: string): Promise<Anthropic> {
    if (this.client) return this.client
    const llmClient = await getLLMClient({
      maxRetries: 0,
      model,
      source: 'standard_provider',
    })
    this.client = llmClient
    return this.client
  }

  async createMessage(request: StandardMessageRequest): Promise<StandardResponse> {
    const client = await this.getClient(request.model)

    const anthropicMessages = standardMessagesToAnthropic(request.messages)
    const tools = standardToolsToAnthropic(request.tools)

    const createFn = (client as any).beta.messages.create.bind((client as any).beta.messages)

    const params: Record<string, unknown> = {
      model: request.model,
      messages: anthropicMessages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 1,
    }

    if (request.system) {
      params.system = [{ type: 'text', text: request.system }]
    }
    if (tools) {
      params.tools = tools
    }
    if (request.toolChoice) {
      params.tool_choice = request.toolChoice
    }
    if (request.topP !== undefined) {
      params.top_p = request.topP
    }

    const response = await createFn(params) as BetaMessage
    return anthropicResponseToStandard(response)
  }

  async *createMessageStream(
    request: StandardMessageRequest,
  ): AsyncIterable<StandardStreamEvent> {
    const client = await this.getClient(request.model)

    const anthropicMessages = standardMessagesToAnthropic(request.messages)
    const tools = standardToolsToAnthropic(request.tools)

    const createFn = (client as any).beta.messages.create.bind((client as any).beta.messages)

    const params: Record<string, unknown> = {
      model: request.model,
      messages: anthropicMessages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 1,
      stream: true,
    }

    if (request.system) {
      params.system = [{ type: 'text', text: request.system }]
    }
    if (tools) {
      params.tools = tools
    }
    if (request.toolChoice) {
      params.tool_choice = request.toolChoice
    }

    const stream = await createFn(params) as AsyncIterable<BetaRawMessageStreamEvent>

    for await (const event of stream) {
      const standardEvent = anthropicStreamEventToStandard(event)
      if (standardEvent) {
        yield standardEvent
      }
    }
  }
}
