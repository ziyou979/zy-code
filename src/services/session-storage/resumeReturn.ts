import type { Message } from '../../types/message.js'
import { getContextWindowForModel } from '../../services/context/modelContext.js'
import { tokenCountFromLastAPIResponse } from '../../services/api/tokens.js'

export type ResumeReturnPrompt = {
  sessionAgeMinutes: number
  estimatedTokens: number
  contextWindow: number
  contextUsagePercent: number
}

export const DEFAULT_RESUME_THRESHOLD_MINUTES = 70
export const DEFAULT_RESUME_CONTEXT_PERCENT = 50

function positiveNumberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function percentageFromEnv(value: string | undefined, fallback: number): number {
  const parsed = positiveNumberFromEnv(value, fallback)
  return parsed <= 100 ? parsed : fallback
}

/**
 * 判断恢复会话是否应提示用户从摘要继续。
 *
 * 与 CC 一致：忽略最近一分钟内的新记录，默认要求离开至少 70 分钟且上下文
 * 达到当前模型上下文窗口的 50%。仅返回展示数据，不在服务层产生用户可见文本。
 */
export function getResumeReturnPrompt(
  messages: readonly Message[],
  dismissed: boolean,
  model: string,
  now = Date.now(),
): ResumeReturnPrompt | null {
  if (dismissed || messages.length === 0) {
    return null
  }
  const cutoff = now - 60_000
  const lastConversationalMessage = messages.findLast(
    (message) =>
      (message.type === 'user' || message.type === 'assistant') &&
      Date.parse(message.timestamp) < cutoff,
  )
  if (!lastConversationalMessage) {
    return null
  }

  const sessionAgeMinutes = (now - Date.parse(lastConversationalMessage.timestamp)) / 60_000
  const minimumAge = positiveNumberFromEnv(
    process.env.ZY_CODE_RESUME_THRESHOLD_MINUTES,
    DEFAULT_RESUME_THRESHOLD_MINUTES,
  )
  if (!Number.isFinite(sessionAgeMinutes) || sessionAgeMinutes < minimumAge) {
    return null
  }

  const estimatedTokens = tokenCountFromLastAPIResponse([...messages])
  const contextWindow = getContextWindowForModel(model)
  const minimumPercent = percentageFromEnv(
    process.env.ZY_CODE_RESUME_CONTEXT_PERCENT,
    DEFAULT_RESUME_CONTEXT_PERCENT,
  )
  const contextUsagePercent = (estimatedTokens / contextWindow) * 100
  if (contextUsagePercent < minimumPercent) {
    return null
  }
  return { sessionAgeMinutes, estimatedTokens, contextWindow, contextUsagePercent }
}
