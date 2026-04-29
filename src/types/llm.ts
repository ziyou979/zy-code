import type { ConnectorTextBlock } from './connectorText.js'

/**
 * 标准 LLM 类型体系 — 独立于任何 SDK 的中间格式。
 *
 * - 不偏向 Anthropic 或 OpenAI，各适配器平等承担转换成本
 * - 消息模型采用 4 角色分离（system/user/assistant/tool）
 * - 内容块只保留通用概念（text/image/tool_call）
 * - 流式事件使用通用命名（response_start/chunk_start 等）
 * - 请求参数只包含通用字段，provider 专属字段通过 providerExtras 传递
 * - 字段命名统一驼峰
 */

// ============================================================================
// 内容块类型
// ============================================================================

/** 用户消息中可用的内容块 */
export type UserContentBlock = TextBlock | ImageBlock

/** 助手消息中可用的内容块 */
export type AssistantContentBlock = TextBlock | ToolCallInlineBlock | ThinkingBlock | RedactedThinkingBlock

// ---- 通用内容块 ----

/** 文本块 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 图片块 — v2 平铺格式，兼容旧嵌套 source 结构 */
export interface ImageBlock {
  type: 'image'
  /** MIME 类型，如 'image/jpeg'、'image/png'（与 source.mediaType 二选一） */
  mimeType?: string
  /** base64 编码的图片数据（与 source.data 二选一） */
  data?: string
  /** @deprecated 兼容旧嵌套结构 */
  source?: ImageSource
}

/**
 * 内联工具调用块。
 * 用于 Anthropic 流式场景（tool_use 作为 content block 逐步输出）。
 * OpenAI 的 tool_calls 通过 AssistantMessage.toolCalls 独立字段传递。
 */
export interface ToolCallInlineBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

// ============================================================================
// 消息类型 — 4 角色分离
// ============================================================================

/** system 消息 — 纯文本系统提示 */
export interface SystemMessage {
  role: 'system'
  content: string
}

/** user 消息 — 用户输入，可包含文本和多模态内容 */
export interface UserMessage {
  role: 'user'
  content: string | UserContentBlock[]
}

/** assistant 消息 — 模型响应，可包含文本和工具调用 */
export interface AssistantMessage {
  role: 'assistant'
  content: string | AssistantContentBlock[]
  /** 工具调用列表（OpenAI 风格独立字段，流式场景也可能使用 ToolCallInlineBlock） */
  toolCalls?: ToolCall[]
  /** 模型使用的 token 用量 */
  usage?: TokenUsage
}

/** tool 消息 — 工具执行结果，独立角色 */
export interface ToolMessage {
  role: 'tool'
  /** 对应的工具调用 ID */
  toolCallId: string
  /** 工具执行结果文本 */
  content: string
  /** 是否执行出错 */
  isError?: boolean
}

/** 请求中的消息联合类型 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

// ============================================================================
// 工具定义
// ============================================================================

/** 标准工具定义 */
export interface ToolDefinition {
  name: string
  description?: string
  /** v2 驼峰命名 — 与 input_schema 二选一提供 */
  inputSchema?: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** @deprecated 使用 inputSchema — 保留以兼容旧代码（宽类型以接收 Record<string, unknown>） */
  input_schema?: Record<string, unknown>
}

/** 工具选择策略 */
export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

// ============================================================================
// 工具调用
// ============================================================================

/** 工具调用（独立于消息内容） */
export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON string
}

// ============================================================================
// 流式事件 — 通用命名
// ============================================================================

/** 流式事件联合类型 */
export type StreamEvent =
  | ResponseStartEvent
  | ChunkStartEvent
  | ChunkDeltaEvent
  | ChunkStopEvent
  | ResponseDeltaEvent
  | ResponseStopEvent

/** 响应开始 — 流的第一个事件 */
export interface ResponseStartEvent {
  type: 'response_start'
  responseId: string
  model: string
}

/** 内容块开始 — 新的内容块开始输出 */
export interface ChunkStartEvent {
  type: 'chunk_start'
  index: number
  chunk: AssistantContentBlock
}

/** 内容增量 — 内容块的增量更新 */
export interface ChunkDeltaEvent {
  type: 'chunk_delta'
  index: number
  delta: ChunkDelta
}

/** 内容块结束 — 一个内容块完成 */
export interface ChunkStopEvent {
  type: 'chunk_stop'
  index: number
}

/** 响应增量 — 响应级别的增量更新 */
export interface ResponseDeltaEvent {
  type: 'response_delta'
  stopReason: StopReason
  usage?: DeltaUsage
}

/** 响应结束 — 流的最后一个事件 */
export interface ResponseStopEvent {
  type: 'response_stop'
}

// ---- 增量类型 ----

/** 内容增量联合类型 */
export type ChunkDelta = TextDelta | ToolCallInputDelta | ThinkingDelta | SignatureDelta | ConnectorTextDelta

/** 文本增量 */
export interface TextDelta {
  type: 'text_delta'
  text: string
}

/** 工具输入增量（JSON 片段） */
export interface ToolCallInputDelta {
  type: 'input_json_delta'
  partialJson: string
}

/** 思考增量 */
export interface ThinkingDelta {
  type: 'thinking_delta'
  thinking: string
}

/** 签名增量 */
export interface SignatureDelta {
  type: 'signature_delta'
  signature: string
}

/** 连接文本增量 */
export interface ConnectorTextDelta {
  type: 'connector_text_delta'
  connector_text: string
}

// ============================================================================
// 停止原因 — 统一枚举
// ============================================================================

/**
 * 停止原因。
 * 合并 Anthropic stop_reason 和 OpenAI finish_reason 为统一枚举。
 */
export type StopReason =
  | 'end_turn'       // 自然结束（Anthropic end_turn / OpenAI stop）
  | 'max_tokens'     // 达到 token 上限（Anthropic max_tokens / OpenAI length）
  | 'tool_use'       // 模型发起工具调用（Anthropic tool_use / OpenAI tool_calls）
  | 'content_filter' // 内容安全过滤（OpenAI content_filter）
  | 'refusal'        // 模型拒绝（OpenAI refusal）
  | 'stop_sequence'  // @deprecated 匹配 stop_sequences 触发，归入 end_turn
  | null

// ============================================================================
// Token 用量
// ============================================================================

/** 完整的 token 用量 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** provider 特定计量（如 Anthropic 的 cache tokens） */
  extras?: Record<string, number>
  /** @deprecated 使用 inputTokens — 保留 required 以兼容旧代码类型断言 */
  input_tokens: number
  /** @deprecated 使用 outputTokens — 保留 required 以兼容旧代码类型断言 */
  output_tokens: number
  /** @deprecated 使用 extras.cacheCreationInputTokens */
  cache_creation_input_tokens?: number
  /** @deprecated 使用 extras.cacheReadInputTokens */
  cache_read_input_tokens?: number
  /** @deprecated 使用 extras.serverToolUseInputTokens */
  server_tool_use_input_tokens?: number
}

/** 增量 token 用量（流式事件中） */
export interface DeltaUsage {
  outputTokens: number
  /** provider 特定增量计量 */
  extras?: Record<string, number>
  /** @deprecated 使用 outputTokens */
  output_tokens?: number
}

// ============================================================================
// 响应
// ============================================================================

/** 完整响应（非流式返回） */
export interface Response {
  id: string
  model: string
  role: 'assistant'
  content: AssistantContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  /** @deprecated 使用 stopReason */
  stop_reason?: StopReason
  /** @deprecated Anthropic 特有字段 */
  stop_sequence?: string | null
  /** @deprecated Anthropic 特有字段（type: 'message'） */
  type?: string
}

// ============================================================================
// 请求参数
// ============================================================================

/** 创建请求参数 — 只包含通用字段 */
export interface CreateParams {
  model: string
  messages: Message[]
  maxTokens: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  stream?: boolean
  /** provider 专属扩展（各适配器自行解析，互不干扰） */
  providerExtras?: ProviderExtras
}

/**
 * Provider 专属扩展字段。
 * 每个 provider 只读取自己的 namespace。
 */
export interface ProviderExtras {
  /** Anthropic 专属：thinking 配置、beta headers、context management、原生工具（web_search_20260209）等 */
  anthropic?: {
    thinking?: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' }
    betas?: string[]
    contextManagement?: Record<string, unknown>
    outputConfig?: Record<string, unknown>
    /** Anthropic 原生工具 schema（如 web_search_20260209），直接透传到 tools 数组 */
    _extraToolSchemas?: Record<string, unknown>[]
  }
  /** OpenAI 专属：structured outputs、parallel tool calls 等 */
  openai?: Record<string, unknown>
  /** 其他 provider 的扩展空间 */
  [key: string]: unknown
}

// ============================================================================
// 适配器接口
// ============================================================================

/** 流式请求的返回结果 */
export interface StreamResult {
  /** 标准格式的事件流 */
  stream: AsyncIterable<StreamEvent>
  /** 服务端返回的请求 ID */
  requestId: string | undefined
  /** 原始 HTTP 响应对象 */
  response: Response | undefined
}

/**
 * 统一的 LLM 请求适配器接口。
 * 各 provider 各自实现，平等承担转换成本。
 */
export interface LLMAdapter {
  /** 创建流式请求 */
  createStream(
    params: CreateParams,
    signal: AbortSignal,
    clientRequestId?: string,
  ): Promise<StreamResult>

  /** 创建非流式请求 */
  createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<Response>

  /** 验证 API key 是否有效 */
  verifyApiKey(apiKey: string): Promise<boolean>
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 标准 LLM API 错误。
 * 统一所有 provider 的错误类型。
 */
export class LLMError extends Error {
  readonly status: number | undefined
  readonly headers: Record<string, string> | undefined

  constructor(
    message: string,
    status?: number,
    headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.headers = headers
  }
}

/** LLM 连接错误 */
export class LLMConnectionError extends LLMError {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'LLMConnectionError'
    this.code = code
  }
}

/** 用户主动中止错误 */
export class LLMAbortError extends LLMError {
  constructor(message: string = 'Request was aborted.') {
    super(message)
    this.name = 'LLMAbortError'
  }
}

/** LLM 认证错误 */
export class LLMAuthenticationError extends LLMError {
  constructor(message: string) {
    super(message, 401)
    this.name = 'LLMAuthenticationError'
  }
}

/** LLM 未找到错误（模型不存在等） */
export class LLMNotFoundError extends LLMError {
  constructor(message: string) {
    super(message, 404)
    this.name = 'LLMNotFoundError'
  }
}

// ============================================================================
// 错误判断工具函数
// ============================================================================

/**
 * 鸭子类型的 API 错误接口。
 * 匹配 LLMError 和任何有 status + message 的错误对象。
 */
export interface APIErrorLike {
  status: number | undefined
  message: string
  headers?: HeadersLike | undefined
}

/** 兼容 Headers 实例和普通对象的 header 访问接口 */
export type HeadersLike =
  | { get?: (name: string) => string | null; [key: string]: unknown }
  | Record<string, string>

/** 从 APIErrorLike 的 headers 中安全获取 header 值 */
export function getHeader(error: APIErrorLike, name: string): string | null {
  const headers = error.headers
  if (!headers) return null
  if (typeof (headers as any).get === 'function') {
    return (headers as any).get(name) ?? null
  }
  return (headers as Record<string, string>)[name] ?? null
}

/**
 * 判断一个 error 是否是 API 错误。
 * 使用鸭子类型：只要有 status 和 message 字段就视为 API 错误。
 */
export function isAPIError(error: unknown): error is APIErrorLike {
  return (
    error instanceof LLMError ||
    (error instanceof Error &&
      'status' in error &&
      typeof (error as any).status === 'number')
  )
}

/**
 * 判断一个 error 是否是连接错误。
 */
export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof LLMConnectionError ||
    (error instanceof Error &&
      (error.constructor.name === 'APIConnectionError' ||
        error.constructor.name === 'APIConnectionTimeoutError'))
  )
}

/**
 * 判断一个 error 是否是连接超时错误。
 */
export function isConnectionTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.constructor.name === 'APIConnectionTimeoutError' ||
      (isConnectionError(error) &&
        error.message.toLowerCase().includes('timeout')))
  )
}

/**
 * 判断一个 error 是否是用户中止错误。
 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof LLMAbortError ||
    (error instanceof Error &&
      error.constructor.name === 'APIUserAbortError')
  )
}

/**
 * 创建一个中止错误实例。
 */
export function createAbortError(): LLMAbortError {
  return new LLMAbortError()
}

// ============================================================================
// 额外内容块类型
// ============================================================================

/**
 * 工具结果内容块。
 * 注意：v2 推荐使用独立的 ToolMessage（role: 'tool'）。
 * 此类型保留用于兼容 Anthropic 格式的消息内容。
 */
export interface ToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  content?: string | Array<TextBlock | ImageBlock>
  isError?: boolean
}

/** 文档块 — 用于 PDF 等多模态文档 */
export interface DocumentBlock {
  type: 'document'
  source: unknown
  title?: string | null
  context?: string | null
}

/** 思考块 — 模型的推理过程 */
export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

/** 加密思考块 — 模型加密的推理内容 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}


/** base64 图片源。ImageBlock.source 使用此类型。 */
export interface ImageSource {
  type: 'base64'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

/** 所有内容块的联合类型（用户内容 + 助手内容 + 工具结果等）。 */
export type ContentBlock = TextBlock | ImageBlock | ToolCallInlineBlock | ToolResultBlock | DocumentBlock | ThinkingBlock | RedactedThinkingBlock | ConnectorTextBlock

/**
 * 安全地获取错误的 status 码。
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof LLMError) return error.status
  if (error instanceof Error && 'status' in error) {
    return (error as any).status
  }
  return undefined
}

/**
 * 安全地获取错误的 message。
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 安全地获取错误的 header 值。
 */
export function getErrorHeader(error: unknown, name: string): string | null {
  if (error instanceof LLMError && error.headers) {
    return error.headers[name] ?? null
  }
  if (error instanceof Error && 'headers' in error) {
    const headers = (error as any).headers
    if (!headers) return null
    if (typeof headers.get === 'function') {
      return headers.get(name) ?? null
    }
    return headers[name] ?? null
  }
  return null
}
