/**
 * Hook payload schema。
 *
 * 定义 hook 输入和输出 payload（agent 与 hook 回调之间交换的数据结构）
 * 的 Zod schema。运行时回调机制位于 ./runtime.ts。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { PermissionBehaviorSchema, PermissionUpdateSchema } from '../coreSchemas.js'
import { WireAssistantMessageErrorSchema } from '../wire/messageSchemas.js'

// ============================================================================
// Hook 类型
// ============================================================================

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'MessageDisplay',
  'PostToolBatch',
  'UserPromptExpansion',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export const HookEventSchema = lazySchema(() => z.enum(HOOK_EVENTS))

export const BaseHookInputSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string().optional(),
    agent_id: z
      .string()
      .optional()
      .describe(
        'Subagent identifier. Present only when the hook fires from within a subagent ' +
          '(e.g., a tool called by an AgentTool worker). Absent for the main thread, ' +
          'even in --agent sessions. Use this field (not agent_type) to distinguish ' +
          'subagent calls from main-thread calls.',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Agent type name (e.g., "General", "code-reviewer"). Present when the ' +
          'hook fires from within a subagent (alongside agent_id), or on the main thread ' +
          'of a session started with --agent (without agent_id).',
      ),
    effort: z
      .object({
        level: z
          .string()
          .describe(
            'Active effort level for the current turn, after any silent downgrade for the ' +
              'selected model. One of: "minimal" | "low" | "medium" | "high" | "max". ' +
              'Absent when the selected model does not support effort.',
          ),
      })
      .optional(),
  }),
)

// 使用 .and() 而非 .extend()，以在生成类型中保留 BaseHookInput & {...}
export const PreToolUseHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PreToolUse'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
    }),
  ),
)

export const PermissionRequestHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PermissionRequest'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      permission_suggestions: z.array(PermissionUpdateSchema()).optional(),
    }),
  ),
)

export const PostToolUseHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostToolUse'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_response: z.unknown(),
      tool_use_id: z.string(),
      duration_ms: z
        .number()
        .optional()
        .describe(
          'Tool execution time in milliseconds (the tool.call() duration only — excludes the ' +
            'permission prompt and PreToolUse hooks).',
        ),
    }),
  ),
)

export const PostToolBatchToolUseSchema = lazySchema(() =>
  z.object({
    tool_name: z.string(),
    tool_use_id: z.string(),
    status: z.enum(['success', 'error']),
  }),
)

export const PostToolBatchHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('PostToolBatch'),
        tool_uses: z.array(PostToolBatchToolUseSchema()),
      }),
    )
    .describe(
      'Hook input for the PostToolBatch event. Fired once after all tool calls in a single ' +
        'assistant turn complete (after their individual PostToolUse hooks), avoiding N+1 hook ' +
        'thrashing for parallel tool calls.',
    ),
)

export const PostToolUseFailureHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostToolUseFailure'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
      error: z.string(),
      is_interrupt: z.boolean().optional(),
    }),
  ),
)

export const PermissionDeniedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PermissionDenied'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
      reason: z.string(),
    }),
  ),
)

export const NotificationHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Notification'),
      message: z.string(),
      title: z.string().optional(),
      notification_type: z.string(),
    }),
  ),
)

export const UserPromptSubmitHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('UserPromptSubmit'),
      prompt: z.string(),
    }),
  ),
)

export const UserPromptExpansionHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('UserPromptExpansion'),
        prompt: z.string().describe('The original user prompt, before expansion.'),
        expanded_text: z
          .string()
          .describe(
            'The fully expanded prompt content the model will see (after @mention/$var/slash ' +
              'expansion, including injected @file contents).',
          ),
      }),
    )
    .describe(
      'Hook input for the UserPromptExpansion event. Fired after @mention/$var/slash expansion and ' +
        'just before UserPromptSubmit, so hooks can audit the actually-injected content.',
    ),
)

export const SessionStartHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SessionStart'),
      source: z.enum(['startup', 'resume', 'clear', 'compact']),
      agent_type: z.string().optional(),
      model: z.string().optional(),
    }),
  ),
)

export const SetupHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Setup'),
      trigger: z.enum(['init', 'maintenance']),
    }),
  ),
)

export const BackgroundTaskInfoSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    description: z.string(),
  }),
)

export const SessionCronInfoSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    schedule: z.string().describe('5-field cron string (local time)'),
    recurring: z.boolean().optional(),
    next_run: z.string().optional().describe('ISO timestamp of the next scheduled run, if known'),
  }),
)

export const StopHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Stop'),
      stop_hook_active: z.boolean(),
      last_assistant_message: z
        .string()
        .optional()
        .describe(
          'Text content of the last assistant message before stopping. ' +
            'Avoids the need to read and parse the transcript file.',
        ),
      background_tasks: z
        .array(BackgroundTaskInfoSchema())
        .optional()
        .describe('Currently running background tasks (shell/agent/workflow/monitor/…).'),
      session_crons: z
        .array(SessionCronInfoSchema())
        .optional()
        .describe('Scheduled cron tasks for this session/project.'),
    }),
  ),
)

export const StopFailureHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('StopFailure'),
      error: WireAssistantMessageErrorSchema(),
      error_details: z.string().optional(),
      last_assistant_message: z.string().optional(),
    }),
  ),
)

export const SubagentStartHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SubagentStart'),
      agent_id: z.string(),
      agent_type: z.string(),
    }),
  ),
)

export const SubagentStopHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SubagentStop'),
      stop_hook_active: z.boolean(),
      agent_id: z.string(),
      agent_transcript_path: z.string(),
      agent_type: z.string(),
      last_assistant_message: z
        .string()
        .optional()
        .describe(
          'Text content of the last assistant message before stopping. ' +
            'Avoids the need to read and parse the transcript file.',
        ),
      background_tasks: z
        .array(BackgroundTaskInfoSchema())
        .optional()
        .describe('Currently running background tasks (shell/agent/workflow/monitor/…).'),
      session_crons: z
        .array(SessionCronInfoSchema())
        .optional()
        .describe('Scheduled cron tasks for this session/project.'),
    }),
  ),
)

export const PreCompactHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PreCompact'),
      trigger: z.enum(['manual', 'auto']),
      custom_instructions: z.string().nullable(),
    }),
  ),
)

export const PostCompactHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostCompact'),
      trigger: z.enum(['manual', 'auto']),
      compact_summary: z.string().describe('The conversation summary produced by compaction'),
    }),
  ),
)

export const TeammateIdleHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TeammateIdle'),
      teammate_name: z.string(),
      team_name: z.string(),
    }),
  ),
)

export const TaskCreatedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TaskCreated'),
      task_id: z.string(),
      task_subject: z.string(),
      task_description: z.string().optional(),
      teammate_name: z.string().optional(),
      team_name: z.string().optional(),
    }),
  ),
)

export const TaskCompletedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TaskCompleted'),
      task_id: z.string(),
      task_subject: z.string(),
      task_description: z.string().optional(),
      teammate_name: z.string().optional(),
      team_name: z.string().optional(),
    }),
  ),
)

export const ElicitationHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('Elicitation'),
        mcp_server_name: z.string(),
        message: z.string(),
        mode: z.enum(['form', 'url']).optional(),
        url: z.string().optional(),
        elicitation_id: z.string().optional(),
        requested_schema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .describe(
      'Hook input for the Elicitation event. Fired when an MCP server requests user input. Hooks can auto-respond (accept/decline) instead of showing the dialog.',
    ),
)

export const ElicitationResultHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('ElicitationResult'),
        mcp_server_name: z.string(),
        elicitation_id: z.string().optional(),
        mode: z.enum(['form', 'url']).optional(),
        action: z.enum(['accept', 'decline', 'cancel']),
        content: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .describe(
      'Hook input for the ElicitationResult event. Fired after the user responds to an MCP elicitation. Hooks can observe or override the response before it is sent to the server.',
    ),
)

export const CONFIG_CHANGE_SOURCES = [
  'user_settings',
  'project_settings',
  'local_settings',
  'policy_settings',
  'skills',
] as const

export const ConfigChangeHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('ConfigChange'),
      source: z.enum(CONFIG_CHANGE_SOURCES),
      file_path: z.string().optional(),
    }),
  ),
)

export const INSTRUCTIONS_LOAD_REASONS = [
  'session_start',
  'nested_traversal',
  'path_glob_match',
  'include',
  'compact',
] as const

export const INSTRUCTIONS_MEMORY_TYPES = ['User', 'Project', 'Local', 'Managed'] as const

export const InstructionsLoadedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('InstructionsLoaded'),
      file_path: z.string(),
      memory_type: z.enum(INSTRUCTIONS_MEMORY_TYPES),
      load_reason: z.enum(INSTRUCTIONS_LOAD_REASONS),
      globs: z.array(z.string()).optional(),
      trigger_file_path: z.string().optional(),
      parent_file_path: z.string().optional(),
    }),
  ),
)

export const WorktreeCreateHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('WorktreeCreate'),
      name: z.string(),
    }),
  ),
)

export const WorktreeRemoveHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('WorktreeRemove'),
      worktree_path: z.string(),
    }),
  ),
)

export const CwdChangedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('CwdChanged'),
      old_cwd: z.string(),
      new_cwd: z.string(),
    }),
  ),
)

export const FileChangedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('FileChanged'),
      file_path: z.string(),
      event: z.enum(['change', 'add', 'unlink']),
    }),
  ),
)

export const MessageDisplayHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('MessageDisplay'),
        message_id: z.string(),
        message_role: z.enum(['assistant', 'user', 'system']),
        text: z.string().describe('The displayable text content of the message.'),
      }),
    )
    .describe(
      'Hook input for the MessageDisplay event. Fired just before a message is rendered, so hooks ' +
        'can transform (transformedText) or hide (hide) the displayed text. Display-only: the ' +
        'conversation context and transcript keep the original content.',
    ),
)

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const

export const ExitReasonSchema = lazySchema(() => z.enum(EXIT_REASONS))

export const SessionEndHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SessionEnd'),
      reason: ExitReasonSchema(),
    }),
  ),
)

export const HookInputSchema = lazySchema(() =>
  z.union([
    PreToolUseHookInputSchema(),
    PostToolUseHookInputSchema(),
    PostToolUseFailureHookInputSchema(),
    PermissionDeniedHookInputSchema(),
    NotificationHookInputSchema(),
    UserPromptSubmitHookInputSchema(),
    SessionStartHookInputSchema(),
    SessionEndHookInputSchema(),
    StopHookInputSchema(),
    StopFailureHookInputSchema(),
    SubagentStartHookInputSchema(),
    SubagentStopHookInputSchema(),
    PreCompactHookInputSchema(),
    PostCompactHookInputSchema(),
    PermissionRequestHookInputSchema(),
    SetupHookInputSchema(),
    TeammateIdleHookInputSchema(),
    TaskCreatedHookInputSchema(),
    TaskCompletedHookInputSchema(),
    ElicitationHookInputSchema(),
    ElicitationResultHookInputSchema(),
    ConfigChangeHookInputSchema(),
    InstructionsLoadedHookInputSchema(),
    WorktreeCreateHookInputSchema(),
    WorktreeRemoveHookInputSchema(),
    CwdChangedHookInputSchema(),
    FileChangedHookInputSchema(),
    MessageDisplayHookInputSchema(),
    PostToolBatchHookInputSchema(),
    UserPromptExpansionHookInputSchema(),
  ]),
)

export const AsyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  }),
)

export const PreToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: PermissionBehaviorSchema().optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  }),
)

export const UserPromptSubmitHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('UserPromptSubmit'),
    additionalContext: z.string().optional(),
  }),
)

export const SessionStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string().optional(),
    initialUserMessage: z.string().optional(),
    watchPaths: z.array(z.string()).optional(),
    // reloadSkills: 设为 true 时，hook 执行后自动重扫技能目录并使新技能在当前 session 中可见
    reloadSkills: z.boolean().optional(),
    // sessionTitle: hook 可在启动时设置/建议会话标题
    sessionTitle: z.string().optional(),
  }),
)

export const SetupHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Setup'),
    additionalContext: z.string().optional(),
  }),
)

export const SubagentStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SubagentStart'),
    additionalContext: z.string().optional(),
  }),
)

export const PostToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().optional(),
    // 面向所有工具的通用结果覆盖（string）：重写 model 看到的 tool result 文本。
    updatedToolOutput: z.string().optional(),
    // MCP 工具专属的结构化结果覆盖（可携带 image/resource）。
    updatedMCPToolOutput: z.unknown().optional(),
  }),
)

export const PostToolUseFailureHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUseFailure'),
    additionalContext: z.string().optional(),
  }),
)

export const PermissionDeniedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionDenied'),
    retry: z
      .boolean()
      .optional()
      .describe(
        'When true, signals that the denied tool call is now approved — the model is told it may ' +
          'retry the call. Only honored for auto-mode classifier denials.',
      ),
  }),
)

export const NotificationHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Notification'),
    additionalContext: z.string().optional(),
  }),
)

export const PermissionRequestHookSpecificOutputSchema = lazySchema(() =>
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
)

export const CwdChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('CwdChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)

export const FileChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('FileChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)

export const MessageDisplayHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('MessageDisplay'),
      transformedText: z
        .string()
        .optional()
        .describe('Replace the displayed text (display-only; does not change context/transcript).'),
      hide: z.boolean().optional().describe('Hide the message from display entirely.'),
    })
    .describe('Hook-specific output for the MessageDisplay event.'),
)

export const PostToolBatchHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolBatch'),
    additionalContext: z.string().optional(),
  }),
)

export const UserPromptExpansionHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('UserPromptExpansion'),
    additionalContext: z.string().optional(),
  }),
)

export const SyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),
    suppressOutput: z.boolean().optional(),
    terminalSequence: z
      .string()
      .optional()
      .describe(
        '原始终端控制序列，由 zy-code 主进程写入 stdout。出于安全仅放行 OSC 0/9（窗口标题/' +
          '桌面通知/进度）与 BEL（响铃）；CSI（光标移动/SGR/清屏）会被丢弃。',
      ),
    stopReason: z.string().optional(),
    decision: z.enum(['approve', 'block']).optional(),
    systemMessage: z.string().optional(),
    reason: z.string().optional(),
    hookSpecificOutput: z
      .union([
        PreToolUseHookSpecificOutputSchema(),
        UserPromptSubmitHookSpecificOutputSchema(),
        SessionStartHookSpecificOutputSchema(),
        SetupHookSpecificOutputSchema(),
        SubagentStartHookSpecificOutputSchema(),
        PostToolUseHookSpecificOutputSchema(),
        PostToolUseFailureHookSpecificOutputSchema(),
        PermissionDeniedHookSpecificOutputSchema(),
        NotificationHookSpecificOutputSchema(),
        PermissionRequestHookSpecificOutputSchema(),
        ElicitationHookSpecificOutputSchema(),
        ElicitationResultHookSpecificOutputSchema(),
        CwdChangedHookSpecificOutputSchema(),
        FileChangedHookSpecificOutputSchema(),
        WorktreeCreateHookSpecificOutputSchema(),
        MessageDisplayHookSpecificOutputSchema(),
        PostToolBatchHookSpecificOutputSchema(),
        UserPromptExpansionHookSpecificOutputSchema(),
      ])
      .optional(),
  }),
)

export const ElicitationHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('Elicitation'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .describe(
      'Hook-specific output for the Elicitation event. Return this to programmatically accept or decline an MCP elicitation request.',
    ),
)

export const ElicitationResultHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('ElicitationResult'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .describe(
      'Hook-specific output for the ElicitationResult event. Return this to override the action or content before the response is sent to the MCP server.',
    ),
)

export const WorktreeCreateHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('WorktreeCreate'),
      worktreePath: z.string(),
    })
    .describe(
      'Hook-specific output for the WorktreeCreate event. Provides the absolute path to the created worktree directory. Command hooks print the path on stdout instead.',
    ),
)

export const HookJSONOutputSchema = lazySchema(() =>
  z.union([AsyncHookJSONOutputSchema(), SyncHookJSONOutputSchema()]),
)
