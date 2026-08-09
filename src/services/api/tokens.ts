import {
  getBytesPerTokenForLanguage,
  roughTokenCountEstimationForMessages,
} from '../tokenEstimation.js'
import type { TokenUsage as Usage } from '../../types/llm.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from '../messages/constants.js'
import { isCompactBoundaryMessage } from '../messages/predicates.js'
import { getHotContextMessages, getLiveApiUsageMessages } from '../messages/projections.js'
import { getInitialSettings } from '../settings/settings.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'

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
    return normalizeTokenUsage(message.message.usage)
  }
  return undefined
}

/**
 * TokenUsage 标准为 camelCase。全零视为无效（压缩后 keep 归零残留）。
 * 历史 snake JSONL 请用 `bun scripts/migrate-token-usage-camel.ts --apply` 迁移，此处不做兼容。
 */
function normalizeTokenUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const u = raw as Record<string, unknown>
  const num = (key: string): number => {
    const v = u[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const inputTokens = num('inputTokens')
  const outputTokens = num('outputTokens')
  const cacheCreationInputTokens = num('cacheCreationInputTokens')
  const cacheReadInputTokens = num('cacheReadInputTokens')

  // 全零视为无效（压缩后 keep 消息的归零残留），避免锚定到过时窗口
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheCreationInputTokens === 0 &&
    cacheReadInputTokens === 0
  ) {
    return undefined
  }

  return {
    // 保留 iterations 等扩展字段供 finalContextTokens 使用
    ...(raw as Usage),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  }
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
  // 排除 keep/summary 上的过时 usage
  const live = getLiveApiUsageMessages(messages)
  let i = live.length - 1
  while (i >= 0) {
    const message = live[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  // 边界后尚无 live usage：用 boundary.postTokens（压缩刚结束 / resume 后）
  return postTokensFromLastBoundary(messages) ?? 0
}

/** 最近 compact boundary 上的 postTokens；无则 undefined */
function postTokensFromLastBoundary(messages: readonly Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || !isCompactBoundaryMessage(message)) {
      continue
    }
    const postTokens = message.compactMetadata?.postTokens
    if (postTokens !== undefined && postTokens > 0) {
      return postTokens
    }
    break
  }
  return undefined
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
  const live = getLiveApiUsageMessages(messages)
  let i = live.length - 1
  while (i >= 0) {
    const message = live[i]
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
  return postTokensFromLastBoundary(messages) ?? 0
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
  const live = getLiveApiUsageMessages(messages)
  let i = live.length - 1
  while (i >= 0) {
    const message = live[i]
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
  // 调用方可传入已切片的 hot 列表；此处不再二次 boundary 切片，避免双重 slice。
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
  // 仅 keep 之后的新 API usage；勿把 messagesToKeep 上压缩前 usage 当 live
  const liveUsage = getCurrentUsage(getLiveApiUsageMessages(messages))
  if (liveUsage) {
    return liveUsage
  }

  const postTokens = postTokensFromLastBoundary(messages)
  if (postTokens !== undefined) {
    return {
      inputTokens: postTokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }
  }

  // 无 boundary / 无 postTokens：回退到全量热上下文上的 usage（未压缩会话）
  return getCurrentUsage(getHotContextMessages(messages))
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
  // 热上下文（含 summary+keep）用于 rough 估算；live usage 锚点排除 keep。
  const hot = getHotContextMessages(messages)
  const liveRegion = getLiveApiUsageMessages(messages)

  // 获取语言感知的 token 估算比率
  const settings = getInitialSettings()
  const languageBpt = getBytesPerTokenForLanguage(settings.language)
  const correctionFactor = 4.0 / languageBpt // 默认比率(4) / 语言实际比率

  // 在 live 区找 usage 锚点；slice 相对 hot 全量（含 keep/summary 之后的 tool_result）
  let i = liveRegion.length - 1
  while (i >= 0) {
    const message = liveRegion[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage) {
      const responseId = getAssistantMessageId(message)
      let anchorInLive = i
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const prior = liveRegion[j]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            anchorInLive = j
          } else if (priorId !== undefined) {
            break
          }
          j--
        }
      }
      const anchorMsg = liveRegion[anchorInLive]
      const hotAnchorIdx = anchorMsg ? hot.findIndex((m) => m.uuid === anchorMsg.uuid) : -1
      const sliceFrom = hotAnchorIdx === -1 ? hot.length : hotAnchorIdx + 1
      return (
        getTokenCountFromUsage(usage) +
        Math.round(
          roughTokenCountEstimationForMessages(
            hot.slice(sliceFrom) as ReadonlyArray<{
              type: string
              message?: { content?: unknown }
            }>,
          ) * correctionFactor,
        )
      )
    }
    i--
  }

  // 无 live usage：优先 boundary.postTokens，并加上 keep 之后新消息的 rough
  const postTokens = postTokensFromLastBoundary(messages)
  if (postTokens !== undefined) {
    const roughAfterKeep = Math.round(
      roughTokenCountEstimationForMessages(
        liveRegion as ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
      ) * correctionFactor,
    )
    return postTokens + roughAfterKeep
  }

  return Math.round(
    roughTokenCountEstimationForMessages(
      hot as ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
    ) * correctionFactor,
  )
}
