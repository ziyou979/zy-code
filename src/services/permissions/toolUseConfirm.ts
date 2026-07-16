import type { z } from 'zod/v4'
import type { AnyObject, Tool, ToolUseContext } from '../../tools/Tool.js'
import type { ContentBlock } from '../../types/llm.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision, PermissionUpdate } from '../../types/permissions.js'

export type WorkerBadgeInfo = {
  name: string
  color: string
}

/** 权限队列中的运行时确认请求，不包含任何 React 组件依赖。 */
export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage
  tool: Tool<Input>
  description: string
  input: z.infer<Input>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  classifierCheckInProgress?: boolean
  classifierAutoApproved?: boolean
  classifierMatchedRule?: string
  workerBadge?: WorkerBadgeInfo
  onUserInteraction(): void
  onAbort(): void
  onDismissCheckmark?(): void
  onAllow(
    updatedInput: z.infer<Input>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlock[],
  ): void
  onReject(feedback?: string, contentBlocks?: ContentBlock[]): void
  recheckPermission(): Promise<void>
}
