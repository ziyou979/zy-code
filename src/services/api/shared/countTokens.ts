/**
 * OpenAI 系 adapter 共用的本地 token 计数。
 *
 * openAIProviderAdapter / openAIResponsesProviderAdapter /
 * openAICodexResponsesProviderAdapter 三个 adapter 原先逐字复制此逻辑；
 * 此处收敛为单一实现。日志由调用方注入（logError），
 * 以保留各自 `createDebugLog('<tag>')` 的 debug 标签。
 */
import { getMainLoopModel, normalizeModelStringForAPI } from '../../model/model.js'
import { countMessagesTokensLocally } from '../../tokenEstimation.js'
import type { LLMMessage, ToolDefinition } from '../../../types/llm.js'

export async function countTokensWithAdapter(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  logError?: (error: unknown) => void,
): Promise<number | null> {
  try {
    const model = normalizeModelStringForAPI(getMainLoopModel() ?? '')
    // 显式 await：async 函数中 return promise 的 rejection 不会被
    // 本 try/catch 捕获，必须 await 才能兜住同步 throw 与异步 rejection。
    const result = await countMessagesTokensLocally(messages, tools, model)
    return result
  } catch (error) {
    logError?.(error)
    return null
  }
}
