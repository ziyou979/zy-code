// SDK Utility Types - types that can't be expressed as Zod schemas.

export type NonNullableUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}
