export type NonNullableUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
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
  // @ts-expect-error
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
