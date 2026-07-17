import type { LocalCommandResult } from '../../commands/index.js'
import type { ToolUseContext } from '../../tools/tool.js'

export async function call(_args: string, context: ToolUseContext): Promise<LocalCommandResult> {
  if (context.openMessageSelector) {
    context.openMessageSelector()
  }
  // Return a skip message to not append any messages.
  return { type: 'skip' }
}
