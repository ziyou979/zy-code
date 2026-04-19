/**
 * OpenAI 专用的查询函数。
 *
 * 使用 OpenAI SDK 直接调用 /v1/chat/completions，
 * 将 Anthropic 格式的参数转换为 OpenAI 格式，
 * 将 OpenAI 的 SSE 响应映射回 Anthropic 格式的事件。
 *
 * 这样不需要修改 zy.ts 中复杂的 Anthropic 专用逻辑。
 */
import type {
  BetaMessage,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaContentBlock,
  BetaMessageDeltaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getAPIMetadata } from './zy.js'
import { getUserAgent } from '../../utils/http.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'

/** 停止原因类型 */
type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null

// ============================================================================
// 工具函数
// ============================================================================

function getOpenAIClient(options: {
  apiKey?: string
  model?: string
}): OpenAI {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1'

  return new OpenAI({
    apiKey,
    baseURL,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    maxRetries: 3,
    defaultHeaders: {
      'User-Agent': getUserAgent(),
    },
  })
}

// ============================================================================
// Anthropic → OpenAI 格式转换
// ============================================================================

type AnthropicContent = string | Array<{
  type: string
  text?: string
  content?: string | Array<{ type: string; text?: string }>
  source?: { type: string; media_type?: string; data?: string }
  id?: string
  name?: string
  input?: unknown
}>

function convertMessagesToOpenAI(
  messages: MessageParam[],
  system?: string | Array<Record<string, unknown>>,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (typeof system === 'string' && system) {
    result.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = system
      .map((b) => (b.type === 'text' ? (b as any).text : ''))
      .filter(Boolean)
      .join('\n\n')
    if (text) result.push({ role: 'system', content: text })
  }

  for (const msg of messages) {
    const content = msg.content
    if (msg.role === 'user') {
      result.push({ role: 'user', content: convertUserContent(content) })
    } else if (msg.role === 'assistant') {
      result.push(convertAssistantMessage(content))
    }
  }

  return result
}

function convertUserContent(
  content: AnthropicContent,
): string | Array<OpenAI.Chat.ChatCompletionContentPart> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text ?? '' })
    } else if (block.type === 'tool_result') {
      const text =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c.text ?? '').join('\n')
            : ''
      parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source?.media_type ?? 'image/png'};base64,${block.source?.data ?? ''}`,
        },
      })
    }
  }
  return parts.length === 1 && parts[0]?.type === 'text'
    ? parts[0].text
    : parts
}

function convertAssistantMessage(
  content: AnthropicContent,
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
  }

  if (typeof content === 'string') {
    msg.content = content
    return msg
  }
  if (!Array.isArray(content)) return msg

  const textParts: string[] = []
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text ?? '')
    } else if (block.type === 'thinking') {
      textParts.push(`<thinking>${block.text ?? ''}</thinking>`)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? randomUUID(),
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: typeof block.input === 'string'
            ? block.input
            : JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  if (textParts.length > 0) msg.content = textParts.join('\n\n')
  if (toolCalls.length > 0) msg.tool_calls = toolCalls

  return msg
}

function convertToolsToOpenAI(
  tools?: BetaToolUnion[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool: any) => ({
    type: 'function' as const,
    function: {
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

function convertOpenAIResponseToAnthropic(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): BetaMessage {
  const choice = completion.choices[0]
  const contentBlocks: BetaContentBlock[] = []

  if (choice?.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content, citations: [] } as BetaContentBlock)
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments ?? '{}'),
      } as BetaContentBlock)
    }
  }

  const stopReasonMap: Record<string, StopReason> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
  }

  return {
    id: completion.id ?? randomUUID(),
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: completion.model ?? model,
    stop_reason: choice?.finish_reason
      ? stopReasonMap[choice.finish_reason] ?? 'end_turn'
      : null,
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  } as BetaMessage
}

// ============================================================================
// OpenAI SSE → Anthropic 流式事件映射
// ============================================================================

async function* mapOpenAIStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<BetaRawMessageStreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  let toolBlockIndices = new Map<number, number>()
  let textBlockStarted = false
  let toolBlocksStarted = new Map<number, boolean>()

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as BetaRawMessageStreamEvent

  for await (const chunk of stream) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // 文本 delta
      if (delta.content && delta.content !== '') {
        if (!textBlockStarted) {
          yield {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          } as BetaRawMessageStreamEvent
          textBlockStarted = true
        }
        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        } as BetaRawMessageStreamEvent
      }

      // tool_calls delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0
          if (!toolBlocksStarted.has(tcIdx)) {
            const anthropicIdx = textBlockStarted
              ? textBlockIndex + 1 + toolBlocksStarted.size
              : tcIdx
            toolBlockIndices.set(tcIdx, anthropicIdx)
            toolBlocksStarted.set(tcIdx, true)
            yield {
              type: 'content_block_start',
              index: anthropicIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id ?? randomUUID(),
                name: tc.function?.name ?? '',
                input: {},
              },
            } as BetaRawMessageStreamEvent
          }
          if (tc.function?.arguments) {
            const anthropicIdx = toolBlockIndices.get(tcIdx) ?? tcIdx
            yield {
              type: 'content_block_delta',
              index: anthropicIdx,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            } as BetaRawMessageStreamEvent
          }
        }
      }

      // finish_reason
      if (choice.finish_reason) {
        // 关闭已打开的 content blocks
        if (textBlockStarted) {
          yield {
            type: 'content_block_stop',
            index: textBlockIndex,
          } as BetaRawMessageStreamEvent
        }
        for (const [, anthropicIdx] of toolBlockIndices) {
          yield {
            type: 'content_block_stop',
            index: anthropicIdx,
          } as BetaRawMessageStreamEvent
        }

        const stopReasonMap: Record<string, StopReason> = {
          stop: 'end_turn',
          length: 'max_tokens',
          tool_calls: 'tool_use',
          content_filter: 'stop_sequence',
        }

        const usage: BetaMessageDeltaUsage = {
          output_tokens: chunk.usage?.completion_tokens ?? 0,
        }

        yield {
          type: 'message_delta',
          delta: {
            stop_reason: stopReasonMap[choice.finish_reason] ?? 'end_turn',
            stop_sequence: null,
          },
          usage,
        } as BetaRawMessageStreamEvent
      }
    }
  }
}

// ============================================================================
// 公开 API — OpenAI 专用查询函数
// ============================================================================

/**
 * OpenAI 非流式消息创建
 */
export async function openAICreateMessage(params: {
  model: string
  messages: MessageParam[]
  system?: string | Array<Record<string, unknown>>
  max_tokens: number
  temperature?: number
  top_p?: number
  tools?: BetaToolUnion[]
  tool_choice?: Record<string, unknown>
  metadata?: Record<string, unknown>
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<BetaMessage> {
  const client = getOpenAIClient({ model: params.model })
  const openAIMessages = convertMessagesToOpenAI(params.messages, params.system)

  logForDebugging(
    `[OpenAI] Non-streaming request: model=${params.model}, messages=${openAIMessages.length}, max_tokens=${params.max_tokens}`,
  )

  const completion = await client.chat.completions.create(
    {
      model: params.model,
      messages: openAIMessages,
      max_tokens: params.max_tokens,
      temperature: params.temperature ?? 1,
      ...(params.top_p !== undefined && { top_p: params.top_p }),
      ...(params.tools && { tools: convertToolsToOpenAI(params.tools) }),
      ...(params.tool_choice && { tool_choice: params.tool_choice as any }),
      stream: false,
      ...(params.extraBody ? (params.extraBody as any) : {}),
    },
    { signal: params.signal },
  )

  return convertOpenAIResponseToAnthropic(completion, params.model)
}

/**
 * OpenAI 流式消息创建，返回 Anthropic 格式的事件流
 */
export async function* openAICreateMessageStream(params: {
  model: string
  messages: MessageParam[]
  system?: string | Array<Record<string, unknown>>
  max_tokens: number
  temperature?: number
  top_p?: number
  tools?: BetaToolUnion[]
  tool_choice?: Record<string, unknown>
  metadata?: Record<string, unknown>
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
}): AsyncIterable<BetaRawMessageStreamEvent> {
  const client = getOpenAIClient({ model: params.model })
  const openAIMessages = convertMessagesToOpenAI(params.messages, params.system)

  logForDebugging(
    `[OpenAI] Streaming request: model=${params.model}, messages=${openAIMessages.length}, max_tokens=${params.max_tokens}`,
  )

  const stream = await client.chat.completions.create(
    {
      model: params.model,
      messages: openAIMessages,
      max_tokens: params.max_tokens,
      temperature: params.temperature ?? 1,
      ...(params.top_p !== undefined && { top_p: params.top_p }),
      ...(params.tools && { tools: convertToolsToOpenAI(params.tools) }),
      ...(params.tool_choice && { tool_choice: params.tool_choice as any }),
      stream: true,
      stream_options: { include_usage: true },
      ...(params.extraBody ? (params.extraBody as any) : {}),
    },
    { signal: params.signal },
  ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

  yield* mapOpenAIStream(stream, params.model)
}

/**
 * 判断当前 provider 是否为原生 OpenAI
 */
export function isOpenAIProvider(): boolean {
  return getAPIProvider() === 'openai'
}
