import { type Output as FileReadToolOutput } from '../../../tools/FileReadTool/FileReadTool.js'
import type { TodoList } from 'src/services/todo/types.js'
import { type Task } from '../../tasks-service/tasks.js'
import { type MemoryFileInfo } from '../../../services/memory/agentsMd.js'
import type { DiagnosticFile } from '../../diagnosticTracking.js'
import type { MessageOrigin } from 'src/types/message.js'
import { type UUID } from 'node:crypto'
import type { ContentBlock } from '../../../types/llm.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import type { DiscoverySignal } from '../../skill-search/signals.js'
import type { TaskType, TaskStatus } from '../../../tasks/task.js'
import type { HookEvent, SyncHookJSONOutput } from 'src/types/index.js'
import { feature } from 'bun:bundle'
import { type HookBlockingError } from '../../hooks.js'
// DCE 条件加载。所有技能搜索字符串字面量，
// 否则会泄露到外部构建中，都放在这些模块内。
// 此文件中唯一的表面是：maybe() 调用（通过下方的 spread 门控）和
// skill_listing 抑制检查（使用相同的 skillSearchModules null 检查）。
// 上方的类型仅 DiscoverySignal 导入在编译时被擦除。
/* eslint-disable @typescript-eslint/no-require-imports */
export const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../../skill-search/featureCheck.js') as typeof import('../../skill-search/featureCheck.js'),
      prefetch:
        require('../../skill-search/prefetch.js') as typeof import('../../skill-search/prefetch.js'),
    }
  : null

export const autoModeStateModule = true
  ? (require('../../permissions/autoModeState.js') as typeof import('../../permissions/autoModeState.js'))
  : null

/* eslint-disable @typescript-eslint/no-require-imports */
export const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../../../tools/BriefTool/prompt.js') as typeof import('../../../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null

export const sessionTranscriptModule = feature('KAIROS')
  ? (require('../../session-transcript/sessionTranscript.js') as typeof import('../../session-transcript/sessionTranscript.js'))
  : null

export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const MAX_MEMORY_LINES = 200

// 仅限制行数无法控制大小（200 × 500 字符行 = 100KB）。
// surfacer 每轮次通过 <system-reminder> 注入最多 5 个文件，
// 绕过每条消息的 tool-result 预算，因此严格的每文件字节上限
// 使总注入有界（5 × 4KB = 20KB/轮次）。通过 readFileInRange
// 的 truncateOnByteLimit 选项强制执行。截断意味着最相关的
// 记忆仍然可见：frontmatter + 开头上下文通常就是关键。
export const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  // 每轮次上限（5 × 4KB = 20KB）限制单次注入，但在
  // 长会话中，选择器会不断涌现不同文件 — 生产环境
  // 观察到的约 ~26K tokens/会话。设置累计字节上限：
  // 达到后完全停止预取。预算约为 3 次完整注入；
  // 之后最相关的记忆已在上下文中。扫描消息
  //（而不是在 toolUseContext 中追踪）意味着自然 compact 会
  // 重置计数器 — 旧附件已从上下文中消失，
  // 因此重新浮现是有效的。
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  /**
   * 文件是否因大小限制而被截断
   */
  truncated?: boolean
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  /**
   * 文件是否因大小限制而被截断
   */
  truncated?: boolean
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type AgentMentionAttachment = {
  type: 'agent_mention'
  agentType: string
}

export type AsyncHookResponseAttachment = {
  type: 'async_hook_response'
  processId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  response: SyncHookJSONOutput
  stdout: string
  stderr: string
  exitCode?: number
}

export type HookAttachment =
  | HookCancelledAttachment
  | {
      type: 'hook_blocking_error'
      blockingError: HookBlockingError
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | {
      type: 'hook_stopped_continuation'
      message: string
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSuccessAttachment
  | {
      type: 'hook_additional_context'
      content: string[]
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment

export type HookPermissionDecisionAttachment = {
  type: 'hook_permission_decision'
  decision: 'allow' | 'deny'
  toolUseID: string
  hookEvent: HookEvent
}

export type HookSystemMessageAttachment = {
  type: 'hook_system_message'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
}

export type HookCancelledAttachment = {
  type: 'hook_cancelled'
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookErrorDuringExecutionAttachment = {
  type: 'hook_error_during_execution'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookSuccessAttachment = {
  type: 'hook_success'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  durationMs?: number
}

export type HookNonBlockingErrorAttachment = {
  type: 'hook_non_blocking_error'
  hookName: string
  stderr: string
  stdout: string
  exitCode: number
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type Attachment =
  /**
   * 用户 @提到了文件
   */
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  /**
   * 一个 @提到的文件被编辑了
   */
  | {
      type: 'edited_text_file'
      filename: string
      snippet: string
    }
  | {
      type: 'edited_image_file'
      filename: string
      content: FileReadToolOutput
    }
  | {
      type: 'directory'
      path: string
      content: string
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'selected_lines_in_ide'
      ideName: string
      lineStart: number
      lineEnd: number
      filename: string
      content: string
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'opened_file_in_ide'
      filename: string
    }
  | {
      type: 'todo_reminder'
      content: TodoList
      itemCount: number
    }
  | {
      type: 'task_reminder'
      content: Task[]
      itemCount: number
    }
  | {
      type: 'nested_memory'
      path: string
      content: MemoryFileInfo
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        /**
         * 预计算的头部字符串（年龄 + 路径前缀）。在附件创建时
         * 计算一次，使渲染的字节在跨轮次时稳定 — 渲染时
         * 重新计算 memoryAge(mtimeMs) 会调用 Date.now()，
         * 所以"3 天前保存"跨轮次变成"4 天前保存" → 不同字节
         * → prompt 缓存失效。
         * 为兼容恢复的会话可选；渲染路径在缺失时回退到重新计算。
         */
        header?: string
        /**
         * readMemoriesForSurfacing 截断文件时的 lineCount，
         * 否则为 undefined。传递到 readFileState 写入，
         * 使 getChangedFiles 跳过被截断的记忆
         *（部分内容会产生误导性的 diff）。
         */
        limit?: number
      }[]
    }
  | {
      type: 'dynamic_skill'
      skillDir: string
      skillNames: string[]
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'skill_listing'
      content: string
      skillCount: number
      isInitial: boolean
    }
  | {
      type: 'skill_discovery'
      skills: {
        name: string
        description: string
        shortId?: string
      }[]
      signal: DiscoverySignal
      source: 'native' | 'aki' | 'both'
    }
  | {
      type: 'queued_command'
      prompt: string | Array<ContentBlock>
      source_uuid?: UUID
      imagePasteIds?: number[]
      /** 原始队列模式 — 用户消息为 'prompt'，系统事件为 'task-notification' */
      commandMode?: string
      /** 从 QueuedCommand 携带的来源，使轮次中排空时保留 */
      origin?: MessageOrigin
      /** 从 QueuedCommand.isMeta 携带 — 区分人类输入与系统注入 */
      isMeta?: boolean
    }
  | {
      type: 'output_style'
      style: string
    }
  | {
      type: 'diagnostics'
      files: DiagnosticFile[]
      isNew: boolean
    }
  | {
      type: 'plan_mode'
      reminderType: 'full' | 'sparse'
      isSubAgent?: boolean
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'plan_mode_reentry'
      planFilePath: string
    }
  | {
      type: 'plan_mode_exit'
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'auto_mode'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'auto_mode_exit'
    }
  | {
      type: 'critical_system_reminder'
      content: string
    }
  | {
      type: 'plan_file_reference'
      planFilePath: string
      planContent: string
    }
  | {
      type: 'mcp_resource'
      server: string
      uri: string
      name: string
      description?: string
      content: ReadResourceResult
    }
  | {
      type: 'command_permissions'
      allowedTools: string[]
      model?: string
    }
  | AgentMentionAttachment
  | {
      type: 'task_status'
      taskId: string
      taskType: TaskType
      status: TaskStatus
      description: string
      deltaSummary: string | null
      outputFilePath?: string
    }
  | AsyncHookResponseAttachment
  | {
      type: 'token_usage'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'budget_usd'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'output_token_usage'
      turn: number
      session: number
      budget: number | null
    }
  | {
      type: 'structured_output'
      data: unknown
    }
  | TeammateMailboxAttachment
  | TeamContextAttachment
  | HookAttachment
  | {
      type: 'invoked_skills'
      skills: Array<{
        name: string
        path: string
        content: string
      }>
    }
  | {
      type: 'verify_plan_reminder'
    }
  | {
      type: 'max_turns_reached'
      maxTurns: number
      turnCount: number
    }
  | {
      type: 'current_session_memory'
      content: string
      path: string
      tokenCount: number
    }
  | {
      type: 'teammate_shutdown_batch'
      count: number
    }
  | {
      type: 'compaction_reminder'
    }
  | {
      type: 'context_efficiency'
    }
  | {
      type: 'date_change'
      newDate: string
    }
  | {
      type: 'ultrathink_effort'
      level: 'high'
    }
  | {
      type: 'deferred_tools_delta'
      addedNames: string[]
      addedLines: string[]
      removedNames: string[]
    }
  | {
      type: 'agent_listing_delta'
      addedTypes: string[]
      addedLines: string[]
      removedTypes: string[]
      /** 是否为会话中的首次公告 */
      isInitial: boolean
      /** 是否包含"并发启动多个代理"说明（非 Pro 订阅） */
      showConcurrencyNote: boolean
    }
  | {
      type: 'mcp_instructions_delta'
      addedNames: string[]
      addedBlocks: string[]
      removedNames: string[]
    }
  | {
      type: 'workflow_reminder'
      reminderKind:
        | 'ultracode_enter_full'
        | 'ultracode_enter_light'
        | 'ultracode_exit'
        | 'workflow_keyword_request'
    }
  | {
      type: 'bagel_console'
      errorCount: number
      warningCount: number
      sample: string
    }

export type TeammateMailboxAttachment = {
  type: 'teammate_mailbox'
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>
}

export type TeamContextAttachment = {
  type: 'team_context'
  agentId: string
  agentName: string
  teamName: string
  teamConfigPath: string
  taskListPath: string
}
