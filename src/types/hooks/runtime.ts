// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { type HookInput } from './payloads.js'
import { type HookEvent, HOOK_EVENTS } from './schemas.js'
import { type PermissionUpdate } from '../coreTypes.generated.js'
import type { HookJSONOutput, AsyncHookJSONOutput, SyncHookJSONOutput } from 'src/types/index.js'
import type { Message } from 'src/types/message.js'
import { PermissionBehaviorSchema, PermissionUpdateSchema } from '../coreSchemas.js'
import type { PermissionResult } from '../permissions.js'

export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.includes(value as HookEvent)
}

// Prompt 引导协议类型。`prompt` key 作为判别字段（与 {async:true} 模式一致），
// 其值为 id。
export const promptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z.string(), // 请求 id
    message: z.string(),
    options: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
)

// PromptRequest / PromptResponse 类型由 coreTypes.generated.ts 导出；
// 上方 schema 仅在此用于运行时校验。

// 同步 hook 响应 schema
export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z
      .boolean()
      .describe('Whether Zy should continue after hook (default: true)')
      .optional(),
    suppressOutput: z.boolean().describe('Hide stdout from transcript (default: false)').optional(),
    terminalSequence: z.string().optional(),
    stopReason: z.string().describe('Message shown when continue is false').optional(),
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().describe('Explanation for the decision').optional(),
    systemMessage: z.string().describe('Warning message shown to the user').optional(),
    hookSpecificOutput: z
      .union([
        z.object({
          hookEventName: z.literal('PreToolUse'),
          permissionDecision: PermissionBehaviorSchema().optional(),
          permissionDecisionReason: z.string().optional(),
          updatedInput: z.record(z.string(), z.unknown()).optional(),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('UserPromptSubmit'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SessionStart'),
          additionalContext: z.string().optional(),
          initialUserMessage: z.string().optional(),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
          reloadSkills: z.boolean().optional(),
          sessionTitle: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('Setup'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SubagentStart'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUse'),
          additionalContext: z.string().optional(),
          updatedToolOutput: z.string().optional(),
          updatedMCPToolOutput: z.unknown().describe('Updates the output for MCP tools').optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUseFailure'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionDenied'),
          retry: z.boolean().optional(),
        }),
        z.object({
          hookEventName: z.literal('Notification'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionRequest'),
          decision: z.union([
            z.object({
              behavior: z.literal('allow'),
              updatedInput: z.record(z.string(), z.unknown()).optional(),
              updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
            }),
            z.object({
              behavior: z.literal('deny'),
              message: z.string().optional(),
              interrupt: z.boolean().optional(),
            }),
          ]),
        }),
        z.object({
          hookEventName: z.literal('Elicitation'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('ElicitationResult'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('CwdChanged'),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('FileChanged'),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('MessageDisplay'),
          transformedText: z.string().optional(),
          hide: z.boolean().optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolBatch'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('UserPromptExpansion'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('WorktreeCreate'),
          worktreePath: z.string(),
        }),
      ])
      .optional(),
  }),
)

// 用于校验 hook JSON 输出的 Zod schema
export const hookJSONOutputSchema = lazySchema(() => {
  // 异步 hook 响应 schema
  const asyncHookResponseSchema = z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  })
  return z.union([asyncHookResponseSchema, syncHookResponseSchema()])
})

// 从 schema 推导 TypeScript 类型
type SchemaHookJSONOutput = z.infer<ReturnType<typeof hookJSONOutputSchema>>

// 判断响应是否同步的类型守卫
export function isSyncHookJSONOutput(json: HookJSONOutput): json is SyncHookJSONOutput {
  return !('async' in json && json.async === true)
}

// 判断响应是否异步的类型守卫
export function isAsyncHookJSONOutput(json: HookJSONOutput): json is AsyncHookJSONOutput {
  return 'async' in json && json.async === true
}

// 在编译期断言 SDK 与 Zod 类型一致
import type { IsEqual } from 'type-fest'
type Assert<T extends true> = T
type _assertSDKTypesMatch = Assert<IsEqual<SchemaHookJSONOutput, HookJSONOutput>>

/** 传给回调 hook 以便访问状态的 context */
export type HookCallbackContext = {
  /** Hook 协议层不暴露 UI store；需要状态的内置 hook 应在服务层注入窄接口。 */
  getAppState: () => unknown
}

/** 回调形式的 Hook。 */
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    /** SessionStart hook 用于计算 CLAUDE_ENV_FILE 路径的索引 */
    hookIndex?: number,
    /** 用于访问应用状态的可选 context */
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  /** 该 hook 的超时时间（秒） */
  timeout?: number
  /** 内部 hook（如 session 文件访问分析）不计入 zy_run_hook 指标 */
  internal?: boolean
}

export type HookCallbackMatcher = {
  matcher?: string
  hooks: HookCallback[]
  pluginName?: string
}

export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

export type HookBlockingError = {
  blockingError: string
  command: string
}

export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }

export type HookResult = {
  message?: Message
  systemMessage?: Message
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}

export type AggregatedHookResult = {
  message?: Message
  blockingErrors?: HookBlockingError[]
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
  /** SessionStart hook 请求重扫技能 */
  reloadSkills?: boolean
  /** SessionStart hook 设置会话标题 */
  sessionTitle?: string
}
