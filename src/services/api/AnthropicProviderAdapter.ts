/**
 * Anthropic Provider Adapter — 将中立标准格式转换为 Anthropic SDK 格式。
 *
 * 此文件是唯一引用 @anthropic-ai/sdk 类型的 adapter。
 * 调用方只使用 llm.ts 中的标准类型。
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMAdapter,
  CreateParams,
  StreamResult,
  StreamEvent,
  Message,
  AssistantContentBlock,
  UserContentBlock,
  TokenUsage,
  DeltaUsage,
  StopReason,
  ToolDefinition,
  ToolChoice,
} from '../../types/llm.js'
import type { Response as LLMResponse } from '../../types/llm.js'
import { getLLMClient } from './client.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { randomUUID } from 'crypto'

// ============================================================================
// 标准格式 → Anthropic 格式
// ============================================================================

function messagesToAnthropic(
  messages: Message[],
): any[] {
  return messages
    .filter((m) => m.role !== 'system' && m.role !== 'tool')
    .map((msg) => {
      if (msg.role === 'user') {
        return {
          role: 'user',
          content: contentToAnthropic(msg.content, 'user'),
        }
      }
      if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: assistantContentToAnthropic(msg.content, msg.toolCalls),
        }
      }
      return null
    })
    .filter(Boolean) as any[]
}

/**
 * 将 tool 消息合并到 Anthropic user 消息中。
 * Anthropic 要求 tool_result 放在 user 消息的 content 数组里。
 */
function mergeToolMessagesIntoUserMessages(messages: Message[]): any[] {
  const result: any[] = []
  const pendingToolResults: any[] = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        toolCallId: msg.toolCallId,
        content: msg.content,
        isError: msg.isError ?? false,
      })
    } else if (msg.role === 'user') {
      // 如果有待发送的 tool_result，作为 user 消息一起发送
      if (pendingToolResults.length > 0) {
        // user 消息本身也可能有内容
        const userContent = typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : (msg.content || []).map(blockToRecord)

        result.push({
          role: 'user',
          content: [...pendingToolResults, ...userContent],
        })
        pendingToolResults.length = 0
      } else {
        result.push({
          role: 'user',
          content: contentToAnthropic(msg.content, 'user'),
        })
      }
    } else if (msg.role === 'assistant') {
      // 发送之前挂起的 tool results（如果没有紧跟 user 消息）
      if (pendingToolResults.length > 0) {
        result.push({
          role: 'user',
          content: pendingToolResults,
        })
        pendingToolResults.length = 0
      }
      result.push({
        role: 'assistant',
        content: assistantContentToAnthropic(msg.content, msg.toolCalls),
      })
    }
    // system 消息由 system param 处理
  }

  // 末尾还有未发送的 tool results
  if (pendingToolResults.length > 0) {
    result.push({
      role: 'user',
      content: pendingToolResults,
    })
  }

  return result
}

function contentToAnthropic(
  content: string | AssistantContentBlock[] | UserContentBlock[],
  role: 'user' | 'assistant',
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map(blockToRecord)
}

function assistantContentToAnthropic(
  content: string | AssistantContentBlock[],
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    // 如果有 toolCalls，需要转为数组格式
    if (toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: content }]
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments || '{}'),
        })
      }
      return blocks
    }
    return content
  }
  return content.map(blockToRecord)
}

function blockToRecord(block: AssistantContentBlock | UserContentBlock): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'tool_call') {
    return {
      type: 'tool_call',
      id: block.id,
      name: block.name,
      input: block.input,
    }
  }
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: block.mimeType,
        data: block.data,
      },
    }
  }
  return { type: 'text', text: JSON.stringify(block) }
}

function toolsToAnthropic(
  tools?: ToolDefinition[],
): ToolDefinition[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  })) as unknown as ToolDefinition[]
}

function toolChoiceToAnthropic(choice?: ToolChoice): Record<string, unknown> | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto': return { type: 'auto' }
    case 'none': return { type: 'none' }
    case 'tool': return { type: 'tool', name: choice.name }
    default: return undefined
  }
}

// ============================================================================
// Anthropic 格式 → 标准格式
// ============================================================================

function anthropicResponseToStandard(
  response: any,
): LLMResponse {
  return {
    id: response.id,
    model: response.model,
    role: 'assistant',
    content: (response.content as unknown as Anthropic.ContentBlock[]).map(anthropicBlockToStandard),
    stopReason: anthropicStopReasonToStandard(response.stop_reason),
    usage: anthropicUsageToStandard(response.usage as unknown as Record<string, unknown>),
  }
}

function anthropicBlockToStandard(block: Anthropic.ContentBlock): AssistantContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_call',
      id: block.id,
      name: block.name,
      input: (block as any).input ?? {},
    }
  }
  // 兜底：未知类型当文本处理
  return { type: 'text', text: JSON.stringify(block) }
}

function anthropicStopReasonToStandard(
  reason: string | null,
): StopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn'
    case 'max_tokens': return 'max_tokens'
    case 'stop_sequence': return 'end_turn'
    case 'tool_use': return 'tool_use'
    default: return null
  }
}

function anthropicUsageToStandard(usage: Record<string, unknown>): TokenUsage {
  const extras: Record<string, number> = {}
  const cacheRead = usage.cache_read_input_tokens as number | undefined
  const cacheWrite = usage.cache_creation_input_tokens as number | undefined
  const serverTool = usage.server_tool_use_input_tokens as number | undefined
  if (cacheRead !== undefined) extras.cacheReadInputTokens = cacheRead
  if (cacheWrite !== undefined) extras.cacheCreationInputTokens = cacheWrite
  if (serverTool !== undefined) extras.serverToolUseInputTokens = serverTool

  const inputTokens = (usage.input_tokens as number) ?? 0
  const outputTokens = (usage.output_tokens as number) ?? 0
  return {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

function anthropicStreamEventToStandard(
  event: any,
): StreamEvent | null {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'response_start',
        responseId: event.message.id,
        model: event.message.model,
      }

    case 'content_block_start': {
      const block = event.content_block as unknown as Record<string, unknown>
      let chunk: AssistantContentBlock
      if (block.type === 'text') {
        chunk = { type: 'text', text: (block.text as string) ?? '' }
      } else if (block.type === 'tool_call') {
        // 保留 tool_use type，让 zy.ts 等消费者能正确判断
        chunk = {
          type: 'tool_call' as any,
          id: (block.id as string) ?? '',
          name: (block.name as string) ?? '',
          input: (block.input as Record<string, unknown>) ?? {},
        }
      } else if (block.type === 'thinking') {
        chunk = { type: 'thinking' as any, thinking: (block.thinking as string) ?? '', signature: (block.signature as string) ?? '' }
      } else if (block.type === 'redacted_thinking') {
        chunk = { type: 'redacted_thinking' as any, data: (block.data as string) ?? '' }
      } else if (block.type === 'server_tool_use') {
        chunk = { type: 'server_tool_use' as any, id: (block.id as string) ?? '', name: (block.name as string) ?? '', input: (block.input as Record<string, unknown>) ?? {} }
      } else {
        return null
      }
      return {
        type: 'chunk_start',
        index: event.index,
        chunk,
      }
    }

    case 'content_block_delta': {
      const delta = event.delta as unknown as Record<string, unknown>
      if (delta.type === 'text_delta') {
        return {
          type: 'chunk_delta',
          index: event.index,
          delta: { type: 'text_delta', text: (delta.text as string) ?? '' },
        }
      }
      if (delta.type === 'input_json_delta') {
        // 保留 partial_json 字段名，zy.ts 直接读取
        return {
          type: 'chunk_delta',
          index: event.index,
          delta: { type: 'input_json_delta', partial_json: (delta.partial_json as string) ?? '' } as any,
        }
      }
      if (delta.type === 'thinking_delta') {
        return {
          type: 'chunk_delta',
          index: event.index,
          delta: { type: 'thinking_delta' as any, thinking: (delta.thinking as string) ?? '' },
        }
      }
      if (delta.type === 'signature_delta') {
        return {
          type: 'chunk_delta',
          index: event.index,
          delta: { type: 'signature_delta' as any, signature: (delta.signature as string) ?? '' },
        }
      }
      return null
    }

    case 'content_block_stop':
      return {
        type: 'chunk_stop',
        index: event.index,
      }

    case 'message_delta':
      return {
        type: 'response_delta',
        stopReason: anthropicStopReasonToStandard(
          (event.delta as any)?.stop_reason ?? null,
        ),
        usage: event.usage ? anthropicDeltaUsageToStandard(event.usage) : undefined,
      }

    case 'message_stop':
      return { type: 'response_stop' }

    default:
      return null
  }
}

function anthropicDeltaUsageToStandard(usage: Record<string, unknown>): DeltaUsage {
  const extras: Record<string, number> = {}
  const cacheRead = usage.cache_read_input_tokens as number | undefined
  const cacheWrite = usage.cache_creation_input_tokens as number | undefined
  if (cacheRead !== undefined) extras.cacheReadInputTokens = cacheRead
  if (cacheWrite !== undefined) extras.cacheCreationInputTokens = cacheWrite

  return {
    outputTokens: (usage.output_tokens as number) ?? 0,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

// ============================================================================
// Provider 实现
// ============================================================================

export class AnthropicProviderAdapter implements LLMAdapter {
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

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    clientRequestId?: string,
  ): Promise<StreamResult> {
    const client = await this.getClient(params.model)
    const anthropicMessages = mergeToolMessagesIntoUserMessages(params.messages)
    const tools = toolsToAnthropic(params.tools)
    const toolChoice = toolChoiceToAnthropic(params.toolChoice)

    const anthropicExtras = params.providerExtras?.anthropic

    const createParams: Record<string, unknown> = {
      model: params.model,
      messages: anthropicMessages,
      max_tokens: params.maxTokens,
      temperature: params.temperature ?? 1,
      stream: true,
    }

    // 系统提示：从 messages 中提取 system 消息
    const systemMsg = params.messages.find(m => m.role === 'system')
    if (systemMsg && systemMsg.role === 'system') {
      createParams.system = [{ type: 'text', text: systemMsg.content }]
    }

    if (tools) createParams.tools = tools
    if (toolChoice) createParams.tool_choice = toolChoice
    if (params.topP !== undefined) createParams.top_p = params.topP
    if (params.stopSequences?.length) createParams.stop_sequences = params.stopSequences
    if (anthropicExtras?.thinking) createParams.thinking = anthropicExtras.thinking
    if (anthropicExtras?.betas) createParams.betas = anthropicExtras.betas
    if (anthropicExtras?.contextManagement) createParams.context_management = anthropicExtras.contextManagement
    if (anthropicExtras?.outputConfig) createParams.output_config = anthropicExtras.outputConfig

    const requestHeaders: Record<string, string> = {}
    if (clientRequestId) {
      requestHeaders['anthropic-client-request-id'] = clientRequestId
    }

    const createFn = (client as any).beta.messages.create.bind((client as any).beta.messages)
    const result = await createFn(createParams, { signal, headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined }).withResponse()

    const rawStream = result.data as unknown as AsyncIterable<any>

    return {
      stream: convertAnthropicStream(rawStream),
      requestId: result.request_id,
      response: result.response,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient(params.model)
    const anthropicMessages = mergeToolMessagesIntoUserMessages(params.messages)
    const tools = toolsToAnthropic(params.tools)
    const toolChoice = toolChoiceToAnthropic(params.toolChoice)

    const anthropicExtras = params.providerExtras?.anthropic

    const createParams: Record<string, unknown> = {
      model: params.model,
      messages: anthropicMessages,
      max_tokens: params.maxTokens,
      temperature: params.temperature ?? 1,
      stream: false,
    }

    const systemMsg = params.messages.find(m => m.role === 'system')
    if (systemMsg && systemMsg.role === 'system') {
      createParams.system = [{ type: 'text', text: systemMsg.content }]
    }

    if (tools) createParams.tools = tools
    if (toolChoice) createParams.tool_choice = toolChoice
    if (params.topP !== undefined) createParams.top_p = params.topP
    if (params.stopSequences?.length) createParams.stop_sequences = params.stopSequences
    if (anthropicExtras?.thinking) createParams.thinking = anthropicExtras.thinking
    if (anthropicExtras?.betas) createParams.betas = anthropicExtras.betas
    if (anthropicExtras?.contextManagement) createParams.context_management = anthropicExtras.contextManagement
    if (anthropicExtras?.outputConfig) createParams.output_config = anthropicExtras.outputConfig

    const createFn = (client as any).beta.messages.create.bind((client as any).beta.messages)
    const response = await createFn(createParams, { signal, timeout }) as any

    return anthropicResponseToStandard(response)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    // Anthropic 的 key 验证通过实际 API 调用完成
    return true
  }
}

async function* convertAnthropicStream(
  rawStream: AsyncIterable<any>,
): AsyncIterable<StreamEvent> {
  for await (const event of rawStream) {
    const standardEvent = anthropicStreamEventToStandard(event)
    if (standardEvent) {
      yield standardEvent
    }
  }
}
