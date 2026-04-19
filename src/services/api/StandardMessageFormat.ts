/**
 * 标准消息格式 — 独立于任何 LLM SDK 的统一消息定义。
 *
 * 设计目标：
 * - 调用方使用此格式，不依赖 Anthropic / OpenAI SDK 类型
 * - 各 provider 实现双向转换
 * - 支持所有常见能力：文本、图片、工具调用、思考
 *
 * 架构：
 * ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
 * │  调用方代码   │───▶│ StandardMessage  │───▶│ Provider Adapter │
 * │ (不依赖SDK)  │    │ (标准格式)        │    │ → SDK 请求       │
 * └─────────────┘    └──────────────────┘    └──────────────────┘
 */

// ============================================================================
// 内容块 — 消息内容的原子单元
// ============================================================================

/** 文本内容 */
export interface StandardTextBlock {
  type: 'text'
  text: string
}

/** 图片内容 */
export interface StandardImageBlock {
  type: 'image'
  mimeType: string
  data: string // base64
}

/** 工具调用 */
export interface StandardToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具调用结果 */
export interface StandardToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string | StandardContentBlock[]
  isError?: boolean
}

/** 思考内容 */
export interface StandardThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type StandardContentBlock =
  | StandardTextBlock
  | StandardImageBlock
  | StandardToolUseBlock
  | StandardToolResultBlock
  | StandardThinkingBlock

// ============================================================================
// 消息 — 对话中的单条消息
// ============================================================================

export interface StandardUserMessage {
  role: 'user'
  content: string | StandardContentBlock[]
}

export interface StandardAssistantMessage {
  role: 'assistant'
  content: string | StandardContentBlock[]
}

export interface StandardSystemMessage {
  role: 'system'
  content: string
}

export type StandardMessage =
  | StandardUserMessage
  | StandardAssistantMessage
  | StandardSystemMessage

// ============================================================================
// 工具定义
// ============================================================================

export interface StandardToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// ============================================================================
// 请求参数
// ============================================================================

export interface StandardMessageRequest {
  model: string
  messages: StandardMessage[]
  system?: string
  maxTokens: number
  temperature?: number
  topP?: number
  tools?: StandardToolDefinition[]
  toolChoice?: { type: 'auto' | 'any' | 'tool'; name?: string }
  stopSequences?: string[]
  /** 是否包含 usage 信息（stream_options.include_usage） */
  streamUsage?: boolean
}

// ============================================================================
// 流式事件
// ============================================================================

export interface StandardMessageStartEvent {
  type: 'message_start'
  messageId: string
  model: string
}

export interface StandardContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  contentBlock: StandardContentBlock
}

export interface StandardTextDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text'; text: string }
}

export interface StandardThinkingDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: { type: 'thinking'; thinking: string }
}

export interface StandardInputJsonDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: { type: 'input_json'; partialJson: string }
}

export interface StandardContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface StandardMessageDeltaEvent {
  type: 'message_delta'
  stopReason: StandardStopReason | null
  usage?: StandardUsage
}

export type StandardStreamEvent =
  | StandardMessageStartEvent
  | StandardContentBlockStartEvent
  | StandardTextDeltaEvent
  | StandardThinkingDeltaEvent
  | StandardInputJsonDeltaEvent
  | StandardContentBlockStopEvent
  | StandardMessageDeltaEvent

// ============================================================================
// 响应
// ============================================================================

export type StandardStopReason =
  | 'end_turn'     // 自然结束
  | 'max_tokens'   // 达到最大 token
  | 'stop_sequence' // 命中停止序列
  | 'tool_use'     // 工具调用
  | null

export interface StandardUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface StandardResponse {
  id: string
  model: string
  role: 'assistant'
  content: StandardContentBlock[]
  stopReason: StandardStopReason
  usage: StandardUsage
}

// ============================================================================
// Provider 接口 — 各 provider 实现此接口
// ============================================================================

export interface LLMProvider {
  readonly name: string

  /** 创建消息（非流式） */
  createMessage(request: StandardMessageRequest): Promise<StandardResponse>

  /** 创建消息流 */
  createMessageStream(
    request: StandardMessageRequest,
  ): AsyncIterable<StandardStreamEvent>
}
