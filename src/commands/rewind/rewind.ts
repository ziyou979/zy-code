import type { LocalCommandResult } from '../../commands/index.js'
import type { ToolUseContext } from '../../tools/tool.js'

export async function call(_args: string, context: ToolUseContext): Promise<LocalCommandResult> {
  if (context.openMessageSelector) {
    context.openMessageSelector()
  }
  // 返回 skip 消息，避免追加任何消息。
  return { type: 'skip' }
}
