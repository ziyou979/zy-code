/**
 * 运行时用量累计类型：内存侧一律 camelCase。
 * Anthropic wire 的 snake 字段只在 conversions/* 边界转换。
 */
export type NonNullableUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  serverToolUse: {
    webSearchRequests: number
    webFetchRequests: number
  }
  serviceTier: string
  cacheCreation: {
    ephemeral1hInputTokens: number
    ephemeral5mInputTokens: number
  }
  /** CACHED_MICROCOMPACT：API 累计删除的 cache token（内存 camel） */
  cacheDeletedInputTokens: number
  inferenceGeo: string
  iterations: unknown[]
  speed: string
}

/**
 * 零初始化的使用量对象。从 logging.ts 中提取，
 * 以便 bridge/replBridge.ts 可以导入它而不会传递引入
 * api/errors.ts → utils/messages.ts → BashTool.tsx → 整个世界。
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  serverToolUse: {
    webSearchRequests: 0,
    webFetchRequests: 0,
  },
  serviceTier: 'standard',
  cacheCreation: {
    ephemeral1hInputTokens: 0,
    ephemeral5mInputTokens: 0,
  },
  cacheDeletedInputTokens: 0,
  inferenceGeo: '',
  iterations: [],
  speed: 'standard',
}
