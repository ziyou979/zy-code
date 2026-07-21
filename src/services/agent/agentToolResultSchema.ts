import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * AgentTool 结果 schema，包含错误语义字段。
 * 提取到独立文件以避免循环依赖。
 */
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheCreationInputTokens: z.number().nullable(),
      cacheReadInputTokens: z.number().nullable(),
      serverToolUse: z
        .object({
          webSearchRequests: z.number(),
          webFetchRequests: z.number(),
        })
        .nullable(),
      serviceTier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cacheCreation: z
        .object({
          ephemeral1hInputTokens: z.number(),
          ephemeral5mInputTokens: z.number(),
        })
        .nullable(),
    }),
    incomplete: z.boolean().optional(),
    errorKind: z
      .enum([
        'usage_limit',
        'rate_limited',
        'server_error',
        'stream_failure',
        'refusal',
        'internal',
      ])
      .optional(),
    errorMessage: z.string().optional(),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>
