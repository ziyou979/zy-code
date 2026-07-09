// @ts-nocheck

import { feature } from 'bun:bundle'
import type { TokenUsage } from '../../types/llm.js'
import type { StreamEvent } from '../../types/message.js'
import type { NonNullableUsage } from './logging.js'

/**
 * 清理流资源以防止内存泄漏。
 * @internal 导出用于测试
 */
export function cleanupStream(stream: AsyncIterable<StreamEvent> | undefined): void {
  if (!stream) {
    return
  }
  try {
    // 通过控制器中止流（如果尚未中止）
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // 忽略 — 流可能已关闭
  }
}

/**
 * 使用流式 API 事件的新值更新使用量统计。
 * 注意：Anthropic 的流式 API 提供累积使用量总计，而非增量。
 * 每个事件包含流中截至该点的完整使用量。
 *
 * 输入相关令牌（input_tokens、cache_creation_input_tokens、cache_read_input_tokens）
 * 通常在 message_start 中设置并保持不变。message_delta 事件可能会发送
 * 这些字段的显式 0 值，不应覆盖 message_start 中的值。
 * 仅当这些字段具有非空、非零值时才更新。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: Partial<NonNullableUsage> | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    inputTokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.inputTokens,
    cacheCreationInputTokens:
      partUsage.cache_creation_input_tokens !== null && partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      partUsage.cache_read_input_tokens !== null && partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cacheReadInputTokens,
    outputTokens: partUsage.output_tokens ?? usage.outputTokens,
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK 类型 DeltaUsage 缺少 cache_creation，但实际存在！
      ephemeral_1h_input_tokens:
        (partUsage as TokenUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as TokenUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // cache_deleted_input_tokens：缓存编辑删除 KV 缓存内容时
    // API 返回该值，但不在 SDK 类型中。从 NonNullableUsage 中移除
    // 以便该字符串通过死代码消除从外部构建中剔除。
    // 使用与其他令牌字段相同的 > 0 守卫，防止 message_delta
    // 用 0 覆盖真实值。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
  }
}

/**
 * 累积消息的使用量到总量对象。
 * 用于跟踪多个助手轮次间的累积使用量。
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    inputTokens: totalUsage.inputTokens + messageUsage.inputTokens,
    cacheCreationInputTokens:
      totalUsage.cacheCreationInputTokens + messageUsage.cacheCreationInputTokens,
    cacheReadInputTokens: totalUsage.cacheReadInputTokens + messageUsage.cacheReadInputTokens,
    outputTokens: totalUsage.outputTokens + messageUsage.outputTokens,
    service_tier: messageUsage.service_tier, // 使用最新的 service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 见 updateUsage 中的注释 — 该字段不在 NonNullableUsage 上，
    // 以保持字符串不出现在外部构建中。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((messageUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // 使用最新的
    iterations: messageUsage.iterations, // 使用最新的
  }
}
