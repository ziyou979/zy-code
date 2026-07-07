/**
 * API 协议格式常量与类型。
 * 单独抽离以打破 providerRegistry.ts ↔ localModelCapabilities.ts 的循环依赖。
 */

/** 支持的 API 协议格式 */
export const API_FORMATS = ['anthropic', 'openai', 'google'] as const

export type ApiFormat = (typeof API_FORMATS)[number]
