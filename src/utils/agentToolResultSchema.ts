import { z } from 'zod/v4'
import { lazySchema } from './lazySchema.js'

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
    // 错误语义字段：以下字段共同表达子代理的完成状态
    // - incomplete: 子代理未完成所有预期工作（被截断/错误中断）
    // - errorKind: 错误分类，帮助父代理决定重试策略
    // - errorMessage: 人类可读的错误描述
    // 不设置这些字段意味着 clean success（保持向后兼容）
    incomplete: z.boolean().optional(),
    errorKind: z
      .enum([
        'usage_limit', // API 用量限额（usage limit / rate limit）
        'rate_limited', // 429 限流
        'server_error', // 5xx / overloaded / server error
        'stream_failure', // 流式中断 / watchdog 超时
        'refusal', // 模型拒绝
        'internal', // 内部错误（超时 / 工具执行失败）
      ])
      .optional(),
    errorMessage: z.string().optional(),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>
