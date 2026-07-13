import {
  getBytesPerTokenForLanguage,
  roughTokenCountEstimationForMessages,
} from '../services/tokenEstimation.js'
import type { TokenUsage as Usage } from '../types/llm.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from './messages/constants.js'
import { getMessagesAfterCompactBoundary, isCompactBoundaryMessage } from './messages/predicates.js'
import { getInitialSettings } from './settings/settings.js'
import { jsonStringify } from './slowOperations.js'

export function getTokenUsage(message: Message): Usage | undefined {
  if (
    message?.type === 'assistant' &&
    'usage' in message.message &&
    !(
      Array.isArray(message.message.content) &&
      message.message.content[0]?.type === 'text' &&
      SYNTHETIC_MESSAGES.has(message.message.content[0].text)
    ) &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.usage
  }
  return undefined
}

/**
 * 获取具有真实（非合成）用量的助手消息的 API 响应 id。
 * 用于识别来自同一 API 响应的拆分助手记录——
 * 并行工具调用流式传输时，每个内容块会成为独立的
 * AssistantMessage 记录，但它们共享同一 message.id。
 */
function getAssistantMessageId(message: Message): string | undefined {
  if (
    message?.type === 'assistant' &&
    'id' in message.message &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.id
  }
  return undefined
}

/**
 * 从 API 响应的用量数据计算上下文窗口总 token 数。
 * 包含 inputTokens + 缓存 token + outputTokens。
 *
 * 这代表该 API 调用时刻的完整上下文大小。
 * 若需要从消息中获取上下文大小，请使用 tokenCountWithEstimation()。
 */
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.inputTokens +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    usage.outputTokens
  )
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  return 0
}

/**
 * 来自最后一次 API 响应 usage.iterations[-1] 的最终上下文窗口大小。
 * 用于跨压缩边界的 task_budget.remaining 计算——
 * 服务端预算倒计时基于上下文，因此剩余量按压缩前的最终窗口递减，
 * 而非计费消耗。服务端计算见 monorepo
 * api/api/sampling/prompt/renderer.py:292。
 *
 * 当 iterations 不存在时回退到顶层 inputTokens + outputTokens
 *（无服务端工具循环，顶层用量即最终窗口）。
 * 两条路径均排除缓存 token 以匹配 #304930 的公式。
 */
export function finalContextTokensFromLastResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      // Stainless 类型尚未包含 iterations——进行类型断言
      const iterations = (
        usage as {
          iterations?: Array<{
            inputTokens?: number
            outputTokens?: number
          }> | null
        }
      ).iterations
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1)!
        const lastIn = last.inputTokens ?? 0
        const lastOut = last.outputTokens ?? 0
        return lastIn + lastOut
      }
      // 无 iterations → 无服务端工具循环 → 顶层用量即最终窗口。
      // 使用 iterations 路径的公式（input + output，不含缓存）
      // 而非 getTokenCountFromUsage——#304930 将最终窗口定义为
      // 非缓存 input + output。服务端预算倒计时
      //（renderer.py:292 calculate_context_tokens）是否以相同方式计算缓存
      // 尚无定论；与 iterations 路径保持对齐，使两条分支在此问题解决前保持一致。
      return usage.inputTokens + usage.outputTokens
    }
    i--
  }
  return 0
}

/**
 * 仅获取最后一次 API 响应的 outputTokens。
 * 不含输入上下文（系统提示、工具、历史消息）。
 *
 * 警告：请勿将此函数用于阈值比较（自动压缩、会话记忆）。
 * 请改用 tokenCountWithEstimation()，它衡量完整上下文大小。
 * 此函数仅用于测量 Zy 在单次响应中生成了多少 token，
 * 而非上下文窗口的填满程度。
 */
export function messageTokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return usage.outputTokens
    }
    i--
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      }
    }
  }
  return null
}

/**
 * statusline / 上下文比例显示用用量。
 *
 * 关键：/compact 后 REPL 仍保留边界前的旧消息（fullscreen 滚动历史），
 * 若直接 getCurrentUsage(fullMessages)，会命中压缩前最后一条 assistant.usage，
 * 导致 statusline 上下文比例「压缩后不变」。
 *
 * 策略（对齐 CC postTokens）：
 * 1. 仅在 last compact boundary 之后的消息中找 API usage
 * 2. 若尚无新 usage，回退到 boundary.compactMetadata.postTokens
 */
export function getDisplayContextUsage(messages: Message[]): {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
} | null {
  const afterBoundary = getMessagesAfterCompactBoundary(messages)
  const liveUsage = getCurrentUsage(afterBoundary)
  if (liveUsage) {
    return liveUsage
  }

  // 无 live usage：从后往前找最近 compact boundary 上的 postTokens
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || !isCompactBoundaryMessage(message)) {
      continue
    }
    const postTokens = message.compactMetadata?.postTokens
    if (postTokens !== undefined && postTokens > 0) {
      return {
        inputTokens: postTokens,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }
    }
    // 找到了边界但没有 postTokens，停止（不要再跨边界取旧 usage）
    break
  }

  return null
}

export function doesMostRecentAssistantMessageExceed200k(messages: Message[]): boolean {
  const THRESHOLD = 200_000

  const lastAsst = messages.findLast((m) => m.type === 'assistant')
  if (!lastAsst) {
    return false
  }
  const usage = getTokenUsage(lastAsst)
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false
}

/**
 * 计算助手消息的字符内容长度。
 * 用于 spinner token 估算（字符数 / 4 ≈ token 数）。
 * 当子智能体流式事件被过滤掉时使用，
 * 此时需要从已完成的消息中统计内容。
 *
 * 统计与 handleMessageFromStream 通过 delta 计算的相同内容：
 * - text（text_delta）
 * - thinking（thinking_delta）
 * - redacted_thinking data
 * - tool_use input（input_json_delta）
 * 注意：signature_delta 不计入流式统计（非模型输出）。
 */
export function getAssistantMessageContentLength(message: AssistantMessage): number {
  let contentLength = 0
  const content = message.message.content
  for (const block of content) {
    if (block.type === 'text') {
      contentLength += block.text.length
    } else if (block.type === 'thinking') {
      contentLength += block.thinking.length
    } else if (block.type === 'redacted_thinking') {
      contentLength += block.data.length
    } else if (block.type === 'tool_call') {
      contentLength += jsonStringify(block.input).length
    }
  }
  return contentLength
}

/**
 * 获取当前上下文窗口的 token 大小。
 *
 * 这是检查阈值（自动压缩、会话记忆初始化等）时
 * 衡量上下文大小的**权威函数**。使用最后一次 API
 * 响应的 token 计数（input + output + cache），
 * 加上此后新增消息的估算值。
 *
 * 请始终使用此函数，而非：
 * - 累积 token 计数（随上下文增长会重复计算）
 * - messageTokenCountFromLastAPIResponse（仅统计 output_tokens）
 * - tokenCountFromLastAPIResponse（不估算新消息）
 *
 * 并行工具调用的实现说明：当模型在一次响应中发起多个
 * 工具调用时，流式代码会为每个内容块单独发出一条 assistant
 * 记录（共享同一 message.id 和 usage），查询循环在每个
 * tool_use 之后立即插入对应的 tool_result。
 * 因此消息数组形如：
 *   [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]
 * 若停在最后一条 assistant 记录，只会估算其后的那一条 tool_result，
 * 而遗漏前面所有插入的 tool_result——这些都会出现在下一次 API 请求中。
 * 为避免低估，找到带用量的记录后，向前回溯到拥有相同 message.id
 * 的**第一条**兄弟记录，确保所有插入的 tool_result 都纳入粗略估算。
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  // 获取语言感知的 token 估算比率
  const settings = getInitialSettings()
  const languageBpt = getBytesPerTokenForLanguage(settings.language)
  const correctionFactor = 4.0 / languageBpt // 默认比率(4) / 语言实际比率

  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage) {
      // 向前回溯，跳过来自同一 API 响应（相同 message.id）的早期兄弟记录，
      // 确保它们之间插入的 tool_result 都包含在估算切片中。
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const prior = messages[j]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            // 同一 API 响应的早期拆分——改以此为锚点。
            i = j
          } else if (priorId !== undefined) {
            // 遇到不同的 API 响应——停止回溯。
            break
          }
          // priorId === undefined：user/tool_result/attachment 消息，
          // 可能插入在拆分记录之间——继续回溯。
          j--
        }
      }
      return (
        getTokenCountFromUsage(usage) +
        Math.round(
          roughTokenCountEstimationForMessages(
            messages.slice(i + 1) as ReadonlyArray<{
              type: string
              message?: { content?: unknown }
            }>,
          ) * correctionFactor,
        )
      )
    }
    i--
  }
  return Math.round(
    roughTokenCountEstimationForMessages(
      messages as ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
    ) * correctionFactor,
  )
}
