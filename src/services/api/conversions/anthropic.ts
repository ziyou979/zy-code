/**
 * Anthropic 双向转换层 — 标准 Message[] / StreamEvent ↔ Anthropic SDK 格式。
 *
 * 设计原则与 conversions/openai.ts 一致：
 * - 公开函数接受标准 llm.ts 类型
 * - 不直接调用任何 Anthropic client
 * - 兼容 v1 (snake_case / 顶层 system / _extraToolSchemas) 与 v2
 */
import type {
  AssistantContentBlock,
  ChunkDelta,
  CreateParams,
  DeltaUsage,
  Message,
  Response as LLMResponse,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  UserContentBlock,
} from '../../../types/llm.js'

// ============================================================================
// 出站：标准 → Anthropic
// ============================================================================

type AnyMessage = Message | Record<string, unknown>

/**
 * 把标准 Message[] 转换为 Anthropic 的 messages 字段。
 *
 * Anthropic 只支持 user / assistant 两种角色：
 * - system 由顶层 system 参数承载（这里直接过滤）
 * - tool 角色被合并到下一条 user 的 content[] 中作为 tool_result 块
 */
export function messagesToAnthropic(messages: AnyMessage[]): any[] {
  const result: any[] = []
  const pendingToolResults: any[] = []

  for (const raw of messages) {
    const msg = raw as any

    if (msg.role === 'system') continue // 由顶层 system 处理

    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.toolCallId, // Anthropic 字段名是 tool_use_id
        content: msg.content,
        ...(msg.isError && { is_error: true }),
      })
      continue
    }

    if (msg.role === 'user') {
      const userContent = userContentToAnthropic(msg.content)
      if (pendingToolResults.length > 0) {
        // tool_result 必须放在 user 消息内
        const merged = [
          ...pendingToolResults,
          ...(typeof userContent === 'string'
            ? userContent
              ? [{ type: 'text', text: userContent }]
              : []
            : userContent),
        ]
        result.push({ role: 'user', content: merged })
        pendingToolResults.length = 0
      } else {
        result.push({ role: 'user', content: userContent })
      }
      continue
    }

    if (msg.role === 'assistant') {
      // 如果在 assistant 之前还有未消化的 tool_results，先发一条 user 消息
      if (pendingToolResults.length > 0) {
        result.push({ role: 'user', content: pendingToolResults.slice() })
        pendingToolResults.length = 0
      }
      result.push({
        role: 'assistant',
        content: assistantContentToAnthropic(msg.content, msg.toolCalls),
      })
    }
  }

  if (pendingToolResults.length > 0) {
    result.push({ role: 'user', content: pendingToolResults })
  }

  return result
}

function userContentToAnthropic(
  content: string | UserContentBlock[] | undefined,
): string | Array<Record<string, unknown>> {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(blockToAnthropic)
}

function assistantContentToAnthropic(
  content: string | AssistantContentBlock[] | undefined,
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
): string | Array<Record<string, unknown>> {
  if (content == null) {
    if (toolCalls?.length) {
      return toolCalls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: safeParseToolArguments(tc.arguments),
      }))
    }
    return ''
  }
  if (typeof content === 'string') {
    if (!toolCalls?.length) return content
    const blocks: Array<Record<string, unknown>> = content
      ? [{ type: 'text', text: content }]
      : []
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: safeParseToolArguments(tc.arguments),
      })
    }
    return blocks
  }
  if (!Array.isArray(content)) return ''
  return content.map(blockToAnthropic)
}

function blockToAnthropic(
  block: AssistantContentBlock | UserContentBlock | Record<string, unknown>,
): Record<string, unknown> {
  const b = block as any
  if (b.type === 'text') return { type: 'text', text: b.text }
  if (b.type === 'tool_call' || b.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: b.id,
      name: b.name,
      input: typeof b.input === 'string' ? safeParseToolArguments(b.input) : b.input ?? {},
    }
  }
  if (b.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: b.thinking ?? '',
      signature: b.signature ?? '',
    }
  }
  if (b.type === 'redacted_thinking') {
    return { type: 'redacted_thinking', data: b.data ?? '' }
  }
  if (b.type === 'image') {
    // v2 平铺 / v1 嵌套 source
    const mediaType = b.mimeType ?? b.source?.mediaType ?? 'image/png'
    const data = b.data ?? b.source?.data ?? ''
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    }
  }
  // 兜底：未知 block 序列化
  return { type: 'text', text: JSON.stringify(block) }
}

function safeParseToolArguments(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export function toolsToAnthropic(
  tools?: ToolDefinition[],
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? (t as any).input_schema,
  }))
}

export function toolChoiceToAnthropic(
  choice?: ToolChoice,
): Record<string, unknown> | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' }
    case 'none':
      return { type: 'none' }
    case 'tool':
      return { type: 'tool', name: choice.name }
    default:
      return undefined
  }
}

// ============================================================================
// 入站：Anthropic → 标准
// ============================================================================

export function anthropicStopReasonToStandard(
  reason: string | null | undefined,
): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case null:
    case undefined:
      return null
    default:
      return null
  }
}

export function anthropicUsageToStandard(usage: any): TokenUsage {
  const extras: Record<string, number> = {}
  if (usage?.cache_creation_input_tokens !== undefined) {
    extras.cacheCreationInputTokens = usage.cache_creation_input_tokens
  }
  if (usage?.cache_read_input_tokens !== undefined) {
    extras.cacheReadInputTokens = usage.cache_read_input_tokens
  }
  if (usage?.server_tool_use_input_tokens !== undefined) {
    extras.serverToolUseInputTokens = usage.server_tool_use_input_tokens
  }
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

export function anthropicDeltaUsageToStandard(usage: any): DeltaUsage {
  const extras: Record<string, number> = {}
  if (usage?.cache_creation_input_tokens !== undefined) {
    extras.cacheCreationInputTokens = usage.cache_creation_input_tokens
  }
  if (usage?.cache_read_input_tokens !== undefined) {
    extras.cacheReadInputTokens = usage.cache_read_input_tokens
  }
  return {
    outputTokens: usage?.output_tokens ?? 0,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

/**
 * 把 Anthropic 单个 SSE 事件转成标准 StreamEvent。
 *
 * 关键事实：Anthropic SDK 原生 content_block_start.content_block.type 是
 *   'tool_use'（不是 'tool_call'），转换层映射成标准的 'tool_call'。
 * 之前在 AnthropicProviderAdapter 里写成 case 'tool_call' 是 bug，
 * 导致工具调用 block 永远拿不到，已在此处统一修复。
 */
export function anthropicStreamEventToStandard(event: any): StreamEvent {
  switch (event.type) {
    case 'message_start': {
      const msg = event.message
      return {
        type: 'response_start',
        responseId: msg.id,
        model: msg.model,
      }
    }
    case 'content_block_start': {
      const block = event.content_block
      let chunk: AssistantContentBlock
      switch (block.type) {
        case 'text':
          chunk = { type: 'text', text: block.text ?? '' }
          break
        case 'tool_use':
          chunk = {
            type: 'tool_call',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          }
          break
        case 'thinking':
          chunk = {
            type: 'thinking' as any,
            thinking: block.thinking ?? '',
            signature: block.signature ?? '',
          } as any
          break
        case 'redacted_thinking':
          chunk = { type: 'redacted_thinking' as any, data: block.data ?? '' } as any
          break
        case 'server_tool_use':
          chunk = {
            type: 'server_tool_use' as any,
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          } as any
          break
        default:
          chunk = { type: 'text', text: '' }
      }
      return { type: 'chunk_start', index: event.index, chunk }
    }
    case 'content_block_delta': {
      const delta = event.delta
      let chunkDelta: ChunkDelta
      switch (delta.type) {
        case 'text_delta':
          chunkDelta = { type: 'text_delta', text: delta.text }
          break
        case 'input_json_delta':
          // SDK 原生 partial_json (snake_case) → 标准 partialJson (camelCase)
          chunkDelta = {
            type: 'input_json_delta',
            partialJson: delta.partial_json ?? '',
          }
          break
        case 'thinking_delta':
          chunkDelta = {
            type: 'thinking_delta' as any,
            thinking: delta.thinking,
          } as any
          break
        case 'signature_delta':
          chunkDelta = {
            type: 'signature_delta' as any,
            signature: delta.signature,
          } as any
          break
        default:
          chunkDelta = { type: 'text_delta', text: '' }
      }
      return { type: 'chunk_delta', index: event.index, delta: chunkDelta }
    }
    case 'content_block_stop':
      return { type: 'chunk_stop', index: event.index }
    case 'message_delta':
      return {
        type: 'response_delta',
        stopReason: anthropicStopReasonToStandard(event.delta?.stop_reason),
        usage: event.usage ? anthropicDeltaUsageToStandard(event.usage) : undefined,
      }
    case 'message_stop':
      return { type: 'response_stop' }
    default:
      return { type: 'response_stop' }
  }
}

export async function* anthropicStreamToStandard(
  rawStream: AsyncIterable<any>,
): AsyncIterable<StreamEvent> {
  for await (const event of rawStream) {
    yield anthropicStreamEventToStandard(event)
  }
}

export function anthropicResponseToStandard(
  result: any,
  model: string,
): LLMResponse {
  const content: AssistantContentBlock[] = (result.content || []).map((block: any) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text ?? '' }
      case 'tool_use':
        return {
          type: 'tool_call',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        }
      case 'thinking':
        // 非流式响应中 thinking 块降级为 text，保留旧版行为
        return { type: 'text', text: block.thinking ?? '' }
      default:
        return { type: 'text', text: '' }
    }
  })

  return {
    id: result.id,
    model: result.model ?? model,
    role: 'assistant',
    content,
    stopReason: anthropicStopReasonToStandard(result.stop_reason),
    usage: anthropicUsageToStandard(result.usage),
  }
}

// ============================================================================
// 请求参数构造
// ============================================================================

/**
 * 把标准 CreateParams 拼成 Anthropic messages.create 参数对象（不含 stream）。
 *
 * 包含：消息 / system 抽离与多条合并 / 工具 / tool_choice / temperature 等基础字段
 * 以及 anthropic 专属：thinking / betas / contextManagement / outputConfig /
 * _extraToolSchemas（Anthropic 原生工具透传）/ extra_body 顶层透传 /
 * v1 snake_case 兼容（max_tokens / top_p / stop_sequences 等）。
 */
export function buildAnthropicCreateParams(
  params: CreateParams,
): Record<string, any> {
  const p = params as any

  const maxTokens = p.maxTokens ?? p.max_tokens
  const topP = p.topP ?? p.top_p
  const stopSequences = p.stopSequences ?? p.stop_sequences

  const anthropicExtras = p.providerExtras?.anthropic
  const thinking = anthropicExtras?.thinking ?? p.thinking
  const betas = anthropicExtras?.betas ?? p.betas
  const contextManagement = anthropicExtras?.contextManagement ?? p.context_management
  const outputConfig = anthropicExtras?.outputConfig ?? p.output_config
  const metadata = p.metadata

  // 消息：抽 system，把 tool 合并进 user.tool_result
  const rawMessages = (p.messages ?? []) as any[]
  const systemMessages = rawMessages.filter((m) => m.role === 'system')
  const anthropicMessages = messagesToAnthropic(rawMessages)

  let systemContent: string | Array<Record<string, unknown>> | undefined
  if (systemMessages.length > 0) {
    systemContent = systemMessages.map((m) => m.content as string).join('\n\n')
  } else if (p.system !== undefined) {
    systemContent = p.system
  }

  // 工具：v1 input_schema / v2 inputSchema 都支持
  const convertedTools = toolsToAnthropic(p.tools)
  // Anthropic 原生工具（如 web_search_20260209）— 直接透传 schema
  const nativeTools = anthropicExtras?._extraToolSchemas ?? []
  const allTools = [...nativeTools, ...(convertedTools ?? [])]

  const out: Record<string, any> = {
    model: p.model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  }
  if (systemContent !== undefined) out.system = systemContent
  if (allTools.length > 0) out.tools = allTools

  const toolChoiceRaw = p.toolChoice ?? p.tool_choice
  if (toolChoiceRaw) {
    out.tool_choice = toolChoiceToAnthropic(toolChoiceRaw) ?? toolChoiceRaw
  }

  if (p.temperature !== undefined) out.temperature = p.temperature
  if (topP !== undefined) out.top_p = topP
  if (stopSequences !== undefined) out.stop_sequences = stopSequences
  if (metadata !== undefined) out.metadata = metadata
  if (thinking !== undefined) out.thinking = thinking
  if (betas !== undefined) out.betas = betas
  if (contextManagement !== undefined) out.context_management = contextManagement
  if (outputConfig !== undefined) out.output_config = outputConfig

  // extra_body 顶层透传
  if (p.extra_body) Object.assign(out, p.extra_body)

  return out
}


