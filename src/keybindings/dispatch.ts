import type { KeybindingContextName } from './types.js'

export type KeybindingHandlerRegistration = {
  action: string
  context: KeybindingContextName
  handler: () => void | false | Promise<void>
}

/**
 * 按 context 优先级调用首个匹配的 handler。
 * 同步返回 false 表示未消费事件；Promise 表示异步任务已启动，按已消费处理。
 */
export function invokeFirstMatchingHandler(
  handlers: Set<KeybindingHandlerRegistration>,
  contexts: KeybindingContextName[],
): boolean {
  for (const context of contexts) {
    for (const registration of handlers) {
      if (registration.context === context) {
        return registration.handler() !== false
      }
    }
  }
  return false
}
