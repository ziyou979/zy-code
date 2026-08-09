// @ts-nocheck

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
 * 输入相关令牌（inputTokens、cacheCreationInputTokens、cacheReadInputTokens）
 * 通常在 message_start 中设置并保持不变。message_delta 事件可能会发送
 * 这些字段的显式 0 值，不应覆盖 message_start 中的值。
 * 仅当这些字段具有非空、非零值时才更新。
 *
 * 内存侧只认 camelCase（TokenUsage / NonNullableUsage）。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: Partial<NonNullableUsage> | Partial<TokenUsage> | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  const inputTokens = partUsage.inputTokens
  const cacheCreationInputTokens = partUsage.cacheCreationInputTokens
  const cacheReadInputTokens = partUsage.cacheReadInputTokens
  const outputTokens = partUsage.outputTokens

  const partAsFull = partUsage as Partial<NonNullableUsage> & Partial<TokenUsage>
  const partCache = partAsFull.cacheCreation
  const partServer = partAsFull.serverToolUse
  const partDeleted = partAsFull.cacheDeletedInputTokens
  const extras = partAsFull.extras

  return {
    inputTokens:
      typeof inputTokens === 'number' && inputTokens > 0 ? inputTokens : usage.inputTokens,
    cacheCreationInputTokens:
      typeof cacheCreationInputTokens === 'number' && cacheCreationInputTokens > 0
        ? cacheCreationInputTokens
        : usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      typeof cacheReadInputTokens === 'number' && cacheReadInputTokens > 0
        ? cacheReadInputTokens
        : usage.cacheReadInputTokens,
    // outputTokens 允许 0（流初期），用 ?? 保留既有值
    outputTokens: typeof outputTokens === 'number' ? outputTokens : usage.outputTokens,
    serviceTier: partAsFull.serviceTier ?? usage.serviceTier,
    cacheCreation: {
      ephemeral1hInputTokens:
        partCache?.ephemeral1hInputTokens ?? usage.cacheCreation.ephemeral1hInputTokens,
      ephemeral5mInputTokens:
        partCache?.ephemeral5mInputTokens ?? usage.cacheCreation.ephemeral5mInputTokens,
    },
    // cacheDeletedInputTokens：>0 守卫，防止 message_delta 用 0 覆盖真实值
    cacheDeletedInputTokens:
      typeof partDeleted === 'number' && partDeleted > 0
        ? partDeleted
        : usage.cacheDeletedInputTokens,
    inferenceGeo: partAsFull.inferenceGeo ?? usage.inferenceGeo,
    iterations: partAsFull.iterations ?? usage.iterations,
    serverToolUse: {
      webSearchRequests:
        partServer?.webSearchRequests ??
        extras?.webSearchRequests ??
        usage.serverToolUse.webSearchRequests,
      webFetchRequests:
        partServer?.webFetchRequests ??
        extras?.webFetchRequests ??
        usage.serverToolUse.webFetchRequests,
    },
    speed: partAsFull.speed ?? usage.speed,
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
    serviceTier: messageUsage.serviceTier,
    cacheCreation: {
      ephemeral1hInputTokens:
        totalUsage.cacheCreation.ephemeral1hInputTokens +
        messageUsage.cacheCreation.ephemeral1hInputTokens,
      ephemeral5mInputTokens:
        totalUsage.cacheCreation.ephemeral5mInputTokens +
        messageUsage.cacheCreation.ephemeral5mInputTokens,
    },
    cacheDeletedInputTokens:
      totalUsage.cacheDeletedInputTokens + messageUsage.cacheDeletedInputTokens,
    inferenceGeo: messageUsage.inferenceGeo,
    iterations: messageUsage.iterations,
    serverToolUse: {
      webSearchRequests:
        totalUsage.serverToolUse.webSearchRequests + messageUsage.serverToolUse.webSearchRequests,
      webFetchRequests:
        totalUsage.serverToolUse.webFetchRequests + messageUsage.serverToolUse.webFetchRequests,
    },
    speed: messageUsage.speed,
  }
}
