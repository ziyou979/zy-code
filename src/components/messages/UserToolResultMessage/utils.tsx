import { HookEvent } from 'commander'
import { Message, ProgressMessage } from 'src/types/message.js'
import { findToolByName, Tools } from '../../../tools/Tool.js'

export function useGetToolFromMessages(
  toolUseID: string,
  tools: Tools,
  lookups: {
    siblingToolUseIDs?: Map<string, Set<string>>
    progressMessagesByToolUseID?: Map<string, ProgressMessage[]>
    inProgressHookCounts?: Map<string, Map<HookEvent, number>>
    resolvedHookCounts?: Map<string, Map<HookEvent, number>>
    toolResultByToolUseID?: Map<string, Message>
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    toolUseByToolUseID: any
    normalizedMessageCount?: number
    resolvedToolUseIDs?: Set<string>
    erroredToolUseIDs?: Set<string>
  },
) {
  const toolUse = lookups.toolUseByToolUseID.get(toolUseID)
  if (!toolUse) {
    return null
  }
  const tool = findToolByName(tools, toolUse.name)
  if (!tool) {
    return null
  }
  return {
    tool,
    toolUse,
  }
}
