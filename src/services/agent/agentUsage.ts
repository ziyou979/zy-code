import type { TokenUsage } from '../../types/llm.js'
import type { Message } from '../../types/message.js'
import { SYNTHETIC_MODEL } from '../messages/constants.js'

export interface AgentAggregateUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * 汇总子智能体全部 API 请求的用量；inputTokens 统一为不含缓存口径（无 inputIncludesCache）。
 * 同一响应拆出的多条记录只取最新 usage；保留下来的嵌套同步 AgentTool 结果一并计入。
 */
export function aggregateAgentUsage(messages: readonly Message[]): AgentAggregateUsage {
  const perResponse = new Map<string, Partial<TokenUsage>>()
  const nested: Partial<TokenUsage>[] = []
  for (const m of messages) {
    if (m.type === 'assistant') {
      if (m.message.usage && m.message.model !== SYNTHETIC_MODEL) {
        perResponse.set(m.message.id || m.uuid, m.message.usage)
      }
    } else if (m.type === 'user') {
      const r = m.toolUseResult as { agentId?: unknown; usage?: Partial<TokenUsage> } | undefined
      if (r && typeof r === 'object' && 'agentId' in r && r.usage) {
        nested.push(r.usage)
      }
    }
  }
  const total: AgentAggregateUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  for (const u of [...perResponse.values(), ...nested]) {
    const cacheRead = u.cacheReadInputTokens ?? u.extras?.cacheReadInputTokens ?? 0
    const cacheWrite = u.cacheCreationInputTokens ?? u.extras?.cacheCreationInputTokens ?? 0
    const input = u.inputTokens ?? 0
    // OpenAI/Google 输入已含缓存，扣除后与 Anthropic 口径一致
    total.inputTokens += u.extras?.inputIncludesCache
      ? Math.max(0, input - cacheRead - cacheWrite)
      : input
    total.outputTokens += u.outputTokens ?? 0
    total.cacheReadInputTokens += cacheRead
    total.cacheCreationInputTokens += cacheWrite
  }
  return total
}
