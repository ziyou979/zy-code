/**
 * Hook payload schemas.
 *
 * Zod schemas for hook input/output payloads (the data shapes exchanged
 * between the agent and hook callbacks). Runtime callback machinery lives
 * in ./runtime.ts.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { PermissionBehaviorSchema, PermissionUpdateSchema } from '../coreSchemas.js'
import { WireAssistantMessageErrorSchema } from '../wire/messageSchemas.js'

// ============================================================================
// Hook Types
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
        'Agent type name (e.g., "general-purpose", "code-reviewer"). Present when the ' +
          'hook fires from within a subagent (alongside agent_id), or on the main thread ' +
          'of a session started with --agent (without agent_id).',
      ),
  }),
)

// Use .and() instead of .extend() to preserve BaseHookInput & {...} in generated types
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
    }),
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
    retry: z.boolean().optional(),
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

export const SyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),
    suppressOutput: z.boolean().optional(),
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
      ])
      .optional(),
  }),
)

export let ElicitationHookSpecificOutputSchema
ElicitationHookSpecificOutputSchema = lazySchema(() =>
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

export let ElicitationResultHookSpecificOutputSchema
ElicitationResultHookSpecificOutputSchema = lazySchema(() =>
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

export let WorktreeCreateHookSpecificOutputSchema
WorktreeCreateHookSpecificOutputSchema = lazySchema(() =>
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

export const PromptRequestOptionSchema = lazySchema(() =>
  z.object({
    key: z.string().describe('Unique key for this option, returned in the response'),
    label: z.string().describe('Display text for this option'),
    description: z.string().optional().describe('Optional description shown below the label'),
  }),
)

export const PromptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z
      .string()
      .describe('Request ID. Presence of this key marks the line as a prompt request.'),
    message: z.string().describe('The prompt message to display to the user'),
    options: z
      .array(PromptRequestOptionSchema())
      .describe('Available options for the user to choose from'),
  }),
)

export const PromptResponseSchema = lazySchema(() =>
  z.object({
    prompt_response: z.string().describe('The request ID from the corresponding prompt request'),
    selected: z.string().describe('The key of the selected option'),
  }),
)
