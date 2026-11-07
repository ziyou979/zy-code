import type { Tool, ToolUseContext } from 'src/tools/tool.js'
import z from 'zod/v4'
import { createDebugLog } from '../../services/infra/debug.js'
import type { PermissionDecision, PermissionDecisionReason } from '../../types/permissions.js'

const permLog = createDebugLog('permissions')

import { lazySchema } from '../../utils/lazySchema.js'
import { applyPermissionUpdates, persistPermissionUpdates } from './permissionUpdate.js'
import { permissionUpdateSchema } from './permissionUpdateSchema.js'

export const inputSchema = lazySchema(() =>
  z.object({
    tool_name: z.string().describe('The name of the tool requesting permission'),
    input: z.record(z.string(), z.unknown()).describe('The input for the tool'),
    toolCallId: z.string().optional().describe('The unique tool use request ID'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

// 权限结果的 Zod schema，用于校验 MCP 权限提示 tool，因此保持为真实 PermissionDecision
// 类型的子集

// 与 types/coreSchemas.ts 中的 PermissionDecisionClassificationSchema 一致。格式错误的值
// 回退为 undefined，与下方 updatedPermissions 的处理相同，避免 SDK host 的错误字符串
// 导致整个 decision 被拒绝。
const decisionClassificationField = lazySchema(() =>
  z.enum(['user_temporary', 'user_permanent', 'user_reject']).optional(),
)

const PermissionAllowResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
    updatedPermissions: z.array(permissionUpdateSchema()).optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

const PermissionDenyResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

export const outputSchema = lazySchema(() =>
  z.union([PermissionAllowResultSchema(), PermissionDenyResultSchema()]),
)

export type Output = z.infer<ReturnType<typeof outputSchema>>

/**
 * 将权限提示 tool 的结果规范化为 PermissionDecision。
 */
export function permissionPromptToolResultToPermissionDecision(
  result: Output,
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseContext: ToolUseContext,
): PermissionDecision {
  const decisionReason: PermissionDecisionReason = {
    type: 'permissionPromptTool',
    permissionPromptToolName: tool.name,
    toolResult: result,
  }
  if (result.behavior === 'allow') {
    const updatedPermissions = result.updatedPermissions
    if (updatedPermissions) {
      toolUseContext.setAppState((prev) => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdates(
          prev.toolPermissionContext,
          updatedPermissions,
        ),
      }))
      persistPermissionUpdates(updatedPermissions)
    }
    // 移动端 client 从推送通知响应时没有原始 tool 输入，因此发送 `{}` 以满足 schema。将空对象
    // 视为“使用原值”，避免 tool 在无参数情况下运行。
    const updatedInput = Object.keys(result.updatedInput).length > 0 ? result.updatedInput : input
    return {
      ...result,
      updatedInput,
      decisionReason,
    }
  } else if (result.behavior === 'deny' && result.interrupt) {
    permLog(`SDK permission prompt deny+interrupt: tool=${tool.name} message=${result.message}`)
    toolUseContext.abortController.abort()
  }
  return {
    ...result,
    decisionReason,
  }
}
