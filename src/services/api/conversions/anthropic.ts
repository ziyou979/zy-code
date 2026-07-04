/**
 * Anthropic 双向转换层 — 标准 Message[] / LLMStreamEvent ↔ Anthropic SDK 格式。
 *
 * 设计原则与 conversions/openai.ts 一致：
 * - 公开函数接受标准 llm.ts 类型
 * - 不直接调用任何 Anthropic client
 * - 兼容 v1 (snake_case / 顶层 system / _extraToolSchemas) 与 v2
 */
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type {
  AssistantContentBlock,
  ChunkDelta,
  CreateParams,
  DeltaUsage,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  StopReason,
  ThinkingConfig,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  UserContentBlock,
} from '../../../types/llm.js'

/**
 * buildAnthropicCreateParams 的返回类型。
 * 继承 SDK 的 MessageCreateParamsBase（保证 client.beta.messages.create 类型匹配），
 * 并追加 SDK 类型中尚未声明的实验性/扩展字段。
 */
export interface AnthropicCreateParams extends MessageCreateParamsBase {
  context_management?: Record<string, unknown>
  output_config?: Record<string, unknown>
}

// ============================================================================
// 出站：标准 → Anthropic
// ============================================================================

type AnyMessage = LLMMessage | Record<string, unknown>

/**
 * 将标准 thinking 配置转换为 Anthropic wire 字段。
 *
 * 业务层使用 camelCase；Anthropic SDK 请求体需要 snake_case。
 */
function convertThinkingToAnthropic(thinking: ThinkingConfig): unknown {
  if (thinking.type === 'enabled' && typeof thinking.budgetTokens === 'number') {
    return {
      type: 'enabled',
      budget_tokens: thinking.budgetTokens,
    }
  }

  return thinking
}

/**
 * 把标准 Message[] 转换为 Anthropic 的 messages 字段。
 *
 * Anthropic 只支持 user / assistant 两种角色：
 * - system 由顶层 system 参数承载（这里直接过滤）
 * - tool 角色被合并到下一条 user 的 content[] 中作为 tool_result 块
 */
// biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
export function messagesToAnthropic(messages: AnyMessage[]): any[] {
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const result: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const pendingToolResults: any[] = []

  for (const raw of messages) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const msg = raw as any

    if (msg.role === 'system') {
      continue // 由顶层 system 处理
    }

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
        content: assistantContentToAnthropic(msg.content),
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
  if (content == null) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content.map(blockToAnthropic)
}

function assistantContentToAnthropic(
  content: string | AssistantContentBlock[] | undefined,
): string | Array<Record<string, unknown>> {
  if (content == null) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content.map(blockToAnthropic)
}

function blockToAnthropic(
  block: AssistantContentBlock | UserContentBlock | Record<string, unknown>,
): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const b = block as any
  const cc = b.cache_control ? { cache_control: b.cache_control } : {}
  if (b.type === 'text') {
    return { type: 'text', text: b.text, ...cc }
  }
  if (b.type === 'tool_call' || b.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: b.id,
      name: b.name,
      input: typeof b.input === 'string' ? safeParseToolArguments(b.input) : (b.input ?? {}),
      ...cc,
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
    const mediaType = b.mimeType ?? 'image/png'
    const data = b.data ?? ''
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
      ...cc,
    }
  }
  // 兜底：未知 block 序列化 — 剥离 cache_control / cache_reference 等缓存元字段，
  // 避免它们泄漏进 text 内容，导致下一轮移除标记时文本变化、缓存前缀失效。
  const { cache_control: _cc, cache_reference: _cr, ...cleanBlock } = b
  return { type: 'text', text: JSON.stringify(cleanBlock), ...cc }
}

function safeParseToolArguments(args: string | undefined): Record<string, unknown> {
  if (!args) {
    return {}
  }
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
  if (!tools?.length) {
    return undefined
  }
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

export function toolChoiceToAnthropic(choice?: ToolChoice): Record<string, unknown> | undefined {
  if (!choice) {
    return undefined
  }
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

export function anthropicStopReasonToStandard(reason: string | null | undefined): StopReason {
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

// biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
export function anthropicUsageToStandard(usage: any): TokenUsage {
  const extras: Record<string, number> = {}
  if (usage?.server_tool_use_input_tokens !== undefined) {
    extras.serverToolUseInputTokens = usage.server_tool_use_input_tokens
  }
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

// biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
export function anthropicDeltaUsageToStandard(usage: any): DeltaUsage {
  return {
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

/**
 * 把 Anthropic 单个 SSE 事件转成标准 LLMStreamEvent。
 *
 * 关键事实：Anthropic SDK 原生 content_block_start.content_block.type 是
 *   'tool_use'（不是 'tool_call'），转换层映射成标准的 'tool_call'。
 * 之前在 AnthropicProviderAdapter 里写成 case 'tool_call' 是 bug，
 * 导致工具调用 block 永远拿不到，已在此处统一修复。
 */
// biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
export function anthropicLLMStreamEventToStandard(event: any): LLMStreamEvent {
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
            type: 'thinking',
            thinking: block.thinking ?? '',
            signature: block.signature ?? '',
            // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展块类型
          } as any
          break
        case 'redacted_thinking':
          // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展块类型
          chunk = { type: 'redacted_thinking', data: block.data ?? '' } as any
          break
        case 'server_tool_use':
          chunk = {
            type: 'server_tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
            // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展块类型
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
            type: 'thinking_delta',
            thinking: delta.thinking,
            // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展 delta 类型
          } as any
          break
        case 'signature_delta':
          chunkDelta = {
            type: 'signature_delta',
            signature: delta.signature,
            // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展 delta 类型
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
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 流式类型转换
  rawStream: AsyncIterable<any>,
): AsyncIterable<LLMStreamEvent> {
  for await (const event of rawStream) {
    yield anthropicLLMStreamEventToStandard(event)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
export function anthropicResponseToStandard(result: any, model: string): LLMResponse {
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
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
export function buildAnthropicCreateParams(params: CreateParams): AnthropicCreateParams {
  // biome-ignore lint/suspicious/noExplicitAny: v1/v2 双格式兼容 + Anthropic 专属历史字段（betas/context_management/metadata）
  const p = params as any

  const maxTokens = p.maxTokens ?? p.max_tokens
  const topP = p.topP ?? p.top_p
  const stopSequences = p.stopSequences ?? p.stop_sequences

  const anthropicExtras = p.providerExtras?.anthropic
  // 标准中立字段优先从类型化路径读取，anthropicExtras 可覆盖
  const thinking = anthropicExtras?.thinking ?? params.thinking
  const betas = anthropicExtras?.betas ?? p.betas
  const contextManagement = anthropicExtras?.contextManagement ?? p.context_management
  const metadata = p.metadata

  // 消息：抽 system，把 tool 合并进 user.tool_result
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const rawMessages = (p.messages ?? []) as any[]
  const systemMessages = rawMessages.filter((m) => m.role === 'system')
  const anthropicMessages = messagesToAnthropic(rawMessages)

  let systemContent: MessageCreateParamsBase['system'] | undefined
  if (systemMessages.length > 0) {
    systemContent = systemMessages.map((m) => m.content as string).join('\n\n')
  } else if (params.system !== undefined) {
    systemContent = typeof params.system === 'string' ? params.system : params.system.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n')
  }

  // 工具：v1 input_schema / v2 inputSchema 都支持
  const convertedTools = toolsToAnthropic(p.tools)
  // Anthropic 原生工具（如 web_search_20260209）— 直接透传 schema
  const nativeTools = anthropicExtras?.extraToolSchemas ?? []
  const allTools = [...nativeTools, ...(convertedTools ?? [])]

  const out: AnthropicCreateParams = {
    model: p.model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  }
  if (systemContent !== undefined) {
    out.system = systemContent
  }
  if (allTools.length > 0) {
    out.tools = allTools
  }

  const toolChoiceRaw = p.toolChoice ?? p.tool_choice
  if (toolChoiceRaw) {
    out.tool_choice = toolChoiceToAnthropic(toolChoiceRaw) ?? toolChoiceRaw
  }

  if (p.temperature !== undefined) {
    out.temperature = p.temperature
  }
  if (topP !== undefined) {
    out.top_p = topP
  }
  if (stopSequences !== undefined) {
    out.stop_sequences = stopSequences
  }
  if (metadata !== undefined) {
    out.metadata = metadata
  }
  if (thinking !== undefined) {
    out.thinking = convertThinkingToAnthropic(thinking) as AnthropicCreateParams['thinking']
  }
  if (betas !== undefined) {
    out.betas = betas
  }
  if (contextManagement !== undefined) {
    out.context_management = contextManagement
  }
  // output_config 从拍平后的字段构造；anthropicExtras.outputConfig 作为全量覆盖
  const hasAnyOutputConfigField =
    params.reasoningEffort || params.responseFormat || params.taskBudget || anthropicExtras?.outputConfig
  if (hasAnyOutputConfigField) {
    const anthropicOutputConfig: Record<string, unknown> = {
      ...(anthropicExtras?.outputConfig ?? {}),
      ...(params.reasoningEffort && { effort: params.reasoningEffort }),
      ...(params.responseFormat && { format: params.responseFormat }),
      ...(params.taskBudget && { task_budget: params.taskBudget }),
    }
    out.output_config = anthropicOutputConfig
  }

  // extra_body 顶层透传
  if (params.extraBody) {
    Object.assign(out, params.extraBody)
  }

  return out
}
