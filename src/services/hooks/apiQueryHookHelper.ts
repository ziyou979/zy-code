import { randomUUID } from 'node:crypto'
import type { QuerySource } from '../../constants/querySource.js'
import { queryModelWithoutStreaming } from '../api/llmOrchestrator.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { extractTextContent } from '../messages/predicates.js'
import { asSystemPrompt } from '../api/systemPromptType.js'
import type { REPLHookContext } from './postSamplingHooks.js'

export type ApiQueryHookContext = REPLHookContext & {
  queryMessageCount?: number
}

export type ApiQueryHookConfig<TResult> = {
  name: QuerySource
  shouldRun: (context: ApiQueryHookContext) => Promise<boolean>

  // 构建发送给 API 的完整消息列表
  buildMessages: (context: ApiQueryHookContext) => Message[]

  // 可选：覆盖系统提示词（默认使用 context.systemPrompt）
  systemPrompt?: string

  // 可选：是否使用 context 中的工具（默认为 true）
  // 设为 false 则传递空的工具数组
  useTools?: boolean

  parseResponse: (content: string, context: ApiQueryHookContext) => TResult
  logResult: (result: ApiQueryResult<TResult>, context: ApiQueryHookContext) => void
  // 必须是函数以确保延迟加载（config 在允许之前就会被访问）
  // 接收 context 参数，以便调用方可以继承主循环的模型配置
  getModel: (context: ApiQueryHookContext) => string
}

export type ApiQueryResult<TResult> =
  | {
      type: 'success'
      queryName: string
      result: TResult
      messageId: string
      model: string
      uuid: string
    }
  | {
      type: 'error'
      queryName: string
      error: Error
      uuid: string
    }

export function createApiQueryHook<TResult>(config: ApiQueryHookConfig<TResult>) {
  return async (context: ApiQueryHookContext): Promise<void> => {
    try {
      const shouldRun = await config.shouldRun(context)
      if (!shouldRun) {
        return
      }

      const uuid = randomUUID()

      // 使用 config 的 buildMessages 函数构建消息
      const messages = config.buildMessages(context)
      context.queryMessageCount = messages.length

      // 如果 config 提供了系统提示词则使用，否则使用 context 中的
      const systemPrompt = config.systemPrompt
        ? asSystemPrompt([config.systemPrompt])
        : context.systemPrompt

      // 使用 config 的工具偏好设置（默认为 true = 使用 context 中的工具）
      const useTools = config.useTools ?? true
      const tools = useTools ? context.toolUseContext.options.tools : []

      // 获取模型（延迟加载）
      const model = config.getModel(context)

      // 发起 API 调用
      const response = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' as const },
        tools,
        signal: createAbortController().signal,
        options: {
          getToolPermissionContext: async () => {
            const appState = context.toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model,
          toolChoice: undefined,
          isNonInteractiveSession: context.toolUseContext.options.isNonInteractiveSession,
          hasAppendSystemPrompt: !!context.toolUseContext.options.appendSystemPrompt,
          temperatureOverride: 0,
          agents: context.toolUseContext.options.agentDefinitions.activeAgents,
          querySource: config.name,
          mcpTools: [],
          agentId: context.toolUseContext.agentId,
        },
      })

      // 解析响应
      const msgContent = Array.isArray(response.message.content) ? response.message.content : []
      const content = extractTextContent(msgContent).trim()

      try {
        const result = config.parseResponse(content, context)
        config.logResult(
          {
            type: 'success',
            queryName: config.name,
            result,
            messageId: response.message.id ?? '',
            model,
            uuid,
          },
          context,
        )
      } catch (error) {
        config.logResult(
          {
            type: 'error',
            queryName: config.name,
            error: error as Error,
            uuid,
          },
          context,
        )
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
