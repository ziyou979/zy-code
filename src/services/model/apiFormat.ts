/**
 * API 协议格式常量与类型。
 * 单独抽离以打破 providerRegistry.ts ↔ localModelCapabilities.ts 的循环依赖。
 */

/**
 * 支持的 API 协议格式。
 * - 'openai-chat' — OpenAI Chat Completions API（chat/completions）
 * - 'openai-responses' — OpenAI Responses API（/responses，gpt-5 / o 系列推荐）
 */
export const API_FORMATS = ['anthropic', 'openai-chat', 'openai-responses', 'google'] as const

export type ApiFormat = (typeof API_FORMATS)[number]
