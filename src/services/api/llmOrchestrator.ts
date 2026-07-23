/**
 * llmOrchestrator — LLM 查询编排入口。
 *
 * 提供流式/非流式查询的公开 API，编排 queryModel 和 nonStreaming 的具体执行。
 * 外部调用方应从此模块导入，无需感知内部子模块布局。
 */
import { withStreamingVCR } from '../vcr.js'
import type { Tools } from '../../tools/tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { SystemPrompt } from './systemPromptType.js'
import type { ThinkingConfig } from '../messages/thinking.js'
import type { Options } from './llm-orchestrator/queryOptions.js'
import { queryModel } from './llm-orchestrator/queryModel.js'
import { executeNonStreamingRequest } from './llm-orchestrator/nonStreaming.js'
export type { Options } from './llm-orchestrator/queryOptions.js'
export { executeNonStreamingRequest }

/**
 * 非流式查询包装：消费 queryModel 生成器并返回最后一条 assistant 消息。
 */
export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    if (signal.aborted) {
      const abortErr = new Error('Request aborted')
      abortErr.name = 'AbortError'
      throw abortErr
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

/**
 * 流式查询包装：将 queryModel 生成器通过 withStreamingVCR 包装。
 */
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
  })
}
