import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'

// Post-sampling hook - 尚未在 settings.json 配置中暴露，仅供程序内部使用

// REPL hooks 的通用上下文（适用于 post-sampling 和 stop hooks）
export type REPLHookContext = {
  messages: Message[] // 完整的消息历史，包含助手的回复
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

export type PostSamplingHook = (context: REPLHookContext) => Promise<void> | void

// post-sampling hooks 的内部注册表
const postSamplingHooks: PostSamplingHook[] = []

/**
 * 注册一个 post-sampling hook，在模型 sampling 完成后被调用
 * 这是一个内部 API，不通过 settings 暴露
 */
export function registerPostSamplingHook(hook: PostSamplingHook): void {
  postSamplingHooks.push(hook)
}

/**
 * 清除所有已注册的 post-sampling hooks（用于测试）
 */
export function clearPostSamplingHooks(): void {
  postSamplingHooks.length = 0
}

/**
 * 执行所有已注册的 post-sampling hooks
 */
export async function executePostSamplingHooks(
  messages: Message[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
): Promise<void> {
  const context: REPLHookContext = {
    messages,
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }

  for (const hook of postSamplingHooks) {
    try {
      await hook(context)
    } catch (error) {
      // 记录日志但不因 hook 错误而中断执行
      logError(toError(error))
    }
  }
}
