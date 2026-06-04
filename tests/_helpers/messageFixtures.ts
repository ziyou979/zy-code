/**
 * 测试消息工厂函数 — 集中构造 mock 对象，消除测试文件中的 `as any` 散射。
 *
 * 设计原则：
 * - 工厂函数接受松散输入（unknown content），内部集中处理类型转换
 * - 调用方无需写 `as any` 或 biome-ignore 注释
 * - LLM 层工厂（createTestMessage / createTestMessages）用于 API conversion 测试
 * - UI 层工厂（createTestUserMessage / createTestAssistantMessage）用于 normalize 测试
 * - 参数层工厂（createTestParams）用于 buildAnthropicCreateParams 等测试
 */
import type { CreateParams, LLMMessage } from '../../src/types/llm.js'
import type { AssistantMessage, UserMessage } from '../../src/types/message.js'

// ============================================================================
// LLM 层工厂 — 用于 messagesToOpenAI / messagesToAnthropic 等 conversion 测试
// ============================================================================

/**
 * 构造单条 LLM 消息 — 接受松散 content，内部处理类型转换。
 *
 * @example
 * createTestMessage('user', 'Hello')
 * createTestMessage('assistant', [{ type: 'text', text: 'Hi' }])
 * createTestMessage('tool', 'result', { toolCallId: 'c1' })
 */
export function createTestMessage(
  role: string,
  content: unknown,
  extra?: Record<string, unknown>,
): LLMMessage {
  // biome-ignore lint/suspicious/noExplicitAny: 工厂函数集中处理类型转换
  return { role, content, ...extra } as any
}

/**
 * 从松散对象数组构造 LLMMessage[] — 适用于内联构造复杂消息序列。
 *
 * @example
 * createTestMessages(
 *   { role: 'user', content: 'hi' },
 *   { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }] },
 *   { role: 'tool', toolCallId: 'c', content: 'done' },
 * )
 */
export function createTestMessages(
  ...specs: Array<Record<string, unknown>>
): LLMMessage[] {
  // biome-ignore lint/suspicious/noExplicitAny: 工厂函数集中处理类型转换
  return specs as any
}

/**
 * 构造最小的 CreateParams 测试对象。
 *
 * @example
 * createTestParams({ messages: [createTestMessage('user', 'hi')] })
 */
export function createTestParams(overrides: Partial<CreateParams> = {}): CreateParams {
  return {
    model: 'test-model',
    messages: [],
    maxTokens: 100,
    ...overrides,
  }
}

// ============================================================================
// UI 层工厂 — 用于 normalize / messages 测试
// ============================================================================

/**
 * 构造 UI 层 UserMessage 测试对象。
 *
 * @example
 * createTestUserMessage('Hello world')
 * createTestUserMessage([{ type: 'text', text: 'hi' }], { uuid: 'custom-uuid' })
 */
export function createTestUserMessage(
  content: string | unknown[],
  opts: Record<string, unknown> = {},
): UserMessage {
  // biome-ignore lint/suspicious/noExplicitAny: 工厂函数集中处理类型转换
  return {
    type: 'user' as const,
    uuid: opts.uuid ?? 'user-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user' as const, content },
    ...opts,
    // biome-ignore lint/suspicious/noExplicitAny: 测试工厂函数集中处理类型转换
  } as any
}

/**
 * 构造 UI 层 AssistantMessage 测试对象。
 *
 * @example
 * createTestAssistantMessage([{ type: 'text', text: 'response' }])
 * createTestAssistantMessage([{ type: 'tool_call', id: 'tc-1', name: 'Bash', input: {} }])
 */
export function createTestAssistantMessage(
  content: unknown[],
  opts: Record<string, unknown> = {},
): AssistantMessage {
  // biome-ignore lint/suspicious/noExplicitAny: 工厂函数集中处理类型转换
  return {
    type: 'assistant' as const,
    uuid: opts.uuid ?? 'asst-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant' as const,
      content,
      id: opts.messageId ?? 'msg-001',
      model: 'test-model',
      stopReason: 'end_turn',
      context_management: null,
    },
    requestId: undefined,
    ...opts,
    // biome-ignore lint/suspicious/noExplicitAny: 测试工厂函数集中处理类型转换
  } as any
}
