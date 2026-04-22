/**
 * 标准 LLM 类型定义。
 *
 * 独立于任何 SDK（Anthropic、OpenAI 等），定义项目内部使用的统一类型。
 * Anthropic 和 OpenAI 完全平等，各自通过适配器将 SDK 类型转换为这些标准类型。
 *
 * 命名原则：参考两种 SDK 的命名，取最能表示抽象概念的名称。
 */

// ============================================================================
// 流式事件类型
// ============================================================================

/** 流式事件的联合类型 */
export type LLMStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent

/** 消息开始事件 — 流的第一个事件，包含消息元数据和初始 usage */
export interface MessageStartEvent {
  type: 'message_start'
  message: LLMMessage
}

/** 内容块开始事件 — 一个新的内容块（文本、工具调用、思考等）开始 */
export interface ContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

/** 内容块增量事件 — 内容块的增量更新 */
export interface ContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: ContentDelta
}

/** 内容块结束事件 — 一个内容块完成 */
export interface ContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

/** 消息增量事件 — 消息级别的增量更新（stop_reason、usage 等） */
export interface MessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason: StopReason
  }
  usage: DeltaUsage
}

/** 消息结束事件 — 流的最后一个事件 */
export interface MessageStopEvent {
  type: 'message_stop'
}

// ============================================================================
// 内容增量类型
// ============================================================================

/** 内容增量的联合类型 */
export type ContentDelta =
  | TextDelta
  | ToolInputDelta
  | ThinkingDelta
  | SignatureDelta
  | ConnectorTextDelta

/** 文本增量 */
export interface TextDelta {
  type: 'text_delta'
  text: string
}

/** 工具输入增量（JSON 片段） */
export interface ToolInputDelta {
  type: 'tool_input_delta'
  partial_json: string
}

/** 思考增量 */
export interface ThinkingDelta {
  type: 'thinking_delta'
  thinking: string
}

/** 签名增量（用于 redacted thinking 验证） */
export interface SignatureDelta {
  type: 'signature_delta'
  signature: string
}

/** 连接文本增量（advisor 等场景） */
export interface ConnectorTextDelta {
  type: 'connector_text_delta'
  connector_text: string
}

// ============================================================================
// 内容块类型（响应中的内容）
// ============================================================================

/** 响应中的内容块联合类型 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ServerToolUseBlock

/** 文本块 */
export interface TextBlock {
  type: 'text'
  text: string
  citations?: unknown[]
}

/** 工具调用块 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** 思考块 */
export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

/** 已编辑的思考块 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

/** 服务端工具调用块（如 web_search、advisor 等） */
export interface ServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

// ============================================================================
// 内容块参数类型（请求中的内容）
// ============================================================================

/** 请求中的内容块参数联合类型 */
export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | DocumentBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam

/** 文本块参数 */
export interface TextBlockParam {
  type: 'text'
  text: string
  cache_control?: CacheControl | null
}

/** 图片块参数 */
export interface ImageBlockParam {
  type: 'image'
  source: Base64ImageSource | URLImageSource
  cache_control?: CacheControl | null
}

/** 工具调用块参数 */
export interface ToolUseBlockParam {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** 工具结果块参数 */
export interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<TextBlockParam | ImageBlockParam>
  is_error?: boolean
  cache_control?: CacheControl | null
}

/** 文档块参数 */
export interface DocumentBlockParam {
  type: 'document'
  source: Base64PDFSource | URLPDFSource | ContentSource
  title?: string | null
  context?: string | null
  cache_control?: CacheControl | null
}

/** 思考块参数 */
export interface ThinkingBlockParam {
  type: 'thinking'
  thinking: string
  signature: string
}

/** 已编辑的思考块参数 */
export interface RedactedThinkingBlockParam {
  type: 'redacted_thinking'
  data: string
}

// ============================================================================
// 媒体源类型
// ============================================================================

/** Base64 图片源 */
export interface Base64ImageSource {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

/** URL 图片源 */
export interface URLImageSource {
  type: 'url'
  url: string
}

/** Base64 PDF 源 */
export interface Base64PDFSource {
  type: 'base64'
  media_type: 'application/pdf'
  data: string
}

/** URL PDF 源 */
export interface URLPDFSource {
  type: 'url'
  url: string
}

/** 内容源 */
export interface ContentSource {
  type: 'content'
  content: string | Array<TextBlockParam | ImageBlockParam>
}

/** 缓存控制 */
export interface CacheControl {
  type: 'ephemeral'
}

// ============================================================================
// 消息类型
// ============================================================================

/** 标准 LLM 消息（替代 BetaMessage） */
export interface LLMMessage {
  /** 消息唯一 ID */
  id: string
  /** 消息角色，始终为 'assistant' */
  role: 'assistant'
  /** 消息内容块数组 */
  content: ContentBlock[]
  /** 使用的模型名称 */
  model: string
  /** 停止原因 */
  stop_reason: StopReason
  /** token 使用量 */
  usage: TokenUsage
  /** 消息类型标识 */
  type?: 'message'
  /** 停止序列 */
  stop_sequence?: string | null
}

/** 消息参数（请求中的消息） */
export interface LLMMessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlockParam[]
}

/** 停止原因 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | null

// ============================================================================
// Token 使用量
// ============================================================================

/** 完整的 token 使用量 */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  server_tool_use_input_tokens?: number
}

/** 增量 token 使用量（流式事件中） */
export interface DeltaUsage {
  output_tokens: number
}

// ============================================================================
// 工具定义类型
// ============================================================================

/** 标准工具定义（替代 BetaToolUnion） */
export interface ToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  cache_control?: CacheControl | null
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 标准 LLM API 错误。
 * 统一 Anthropic 的 APIError 和 OpenAI 的错误类型。
 */
export class LLMError extends Error {
  /** HTTP 状态码 */
  readonly status: number | undefined
  /** 响应头 */
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
  /** 底层错误代码（如 ECONNRESET、EPIPE） */
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
 * 同时匹配 LLMError 和 Anthropic APIError（它们都有 status、message、headers）。
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
 * 判断一个 error 是否是 API 错误（LLMError 或 Anthropic APIError 等）。
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
 * 判断一个 error 是否是连接错误（LLMConnectionError 或 Anthropic APIConnectionError 等）。
 * 使用鸭子类型：检查 error.name 或 constructor.name 是否包含 'Connection'。
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
 * 优先使用 LLMAbortError，但如果 Anthropic SDK 可用则使用 APIUserAbortError
 * 以保持与现有 catch 逻辑的兼容性。
 */
export function createAbortError(): LLMAbortError {
  return new LLMAbortError()
}

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

// ============================================================================
// 请求参数类型
// ============================================================================

/** 标准的消息创建请求参数 */
export interface LLMCreateParams {
  model: string
  messages: LLMMessageParam[]
  max_tokens: number
  system?: string | TextBlockParam[]
  tools?: ToolDefinition[]
  tool_choice?: ToolChoice
  temperature?: number
  top_p?: number
  metadata?: Record<string, unknown>
  /** 流式请求 */
  stream?: boolean
  /** Anthropic 特有：thinking 配置 */
  thinking?: ThinkingConfig
  /** Anthropic 特有：beta headers */
  betas?: string[]
  /** Anthropic 特有：上下文管理 */
  context_management?: Record<string, unknown>
  /** Anthropic 特有：输出配置 */
  output_config?: Record<string, unknown>
  /** 额外的 provider 特定参数 */
  extra_body?: Record<string, unknown>
}

/** 工具选择策略 */
export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

/** 思考配置 */
export type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }

// ============================================================================
// 适配器接口
// ============================================================================

/** 流式请求的返回结果 */
export interface StreamResult {
  /** 标准格式的事件流 */
  stream: AsyncIterable<LLMStreamEvent>
  /** 服务端返回的请求 ID */
  request_id: string | undefined
  /** 原始 HTTP 响应对象 */
  response: Response | undefined
}

/**
 * 统一的 LLM 请求适配器接口。
 * Anthropic 和 OpenAI 各自实现此接口。
 */
export interface LLMRequestAdapter {
  /** 创建流式请求 */
  createStream(
    params: LLMCreateParams,
    signal: AbortSignal,
    client_request_id?: string,
  ): Promise<StreamResult>

  /** 创建非流式请求 */
  createMessage(
    params: LLMCreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMMessage>

  /** 验证 API key 是否有效 */
  verifyApiKey(apiKey: string): Promise<boolean>
}
