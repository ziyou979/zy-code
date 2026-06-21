/**
 * SDK Core Schemas - Zod schemas for serializable SDK data types.
 *
 * These schemas are the single source of truth for SDK data types.
 * TypeScript types are generated from these schemas and committed for IDE support.
 *
 * @see scripts/generate-sdk-types.ts for type generation
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

// ============================================================================
// Usage & Model Types
// ============================================================================

export const ModelUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    webSearchRequests: z.number(),
    costUSD: z.number(),
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
  }),
)

// ============================================================================
// Output Format Types
// ============================================================================

export const OutputFormatTypeSchema = lazySchema(() => z.literal('json_schema'))

export const BaseOutputFormatSchema = lazySchema(() =>
  z.object({
    type: OutputFormatTypeSchema(),
  }),
)

export const JsonSchemaOutputFormatSchema = lazySchema(() =>
  z.object({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.unknown()),
  }),
)

export const OutputFormatSchema = lazySchema(() => JsonSchemaOutputFormatSchema())

// ============================================================================
// Config Types
// ============================================================================

export const ApiKeySourceSchema = lazySchema(() =>
  z.enum(['user', 'project', 'org', 'temporary', 'oauth']),
)

export const ConfigScopeSchema = lazySchema(() =>
  z.enum(['local', 'user', 'project']).describe('Config scope for settings.'),
)

export const SdkBetaSchema = lazySchema(() => z.literal('context-1m-2025-08-07'))

export const ThinkingAdaptiveSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('adaptive'),
    })
    .describe('Zy decides when and how much to think (Opus 4.6+).'),
)

export const ThinkingEnabledSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('enabled'),
      budgetTokens: z.number().optional(),
    })
    .describe('Fixed thinking token budget (older models)'),
)

export const ThinkingDisabledSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('disabled'),
    })
    .describe('No extended thinking'),
)

export const ThinkingConfigSchema = lazySchema(() =>
  z
    .union([ThinkingAdaptiveSchema(), ThinkingEnabledSchema(), ThinkingDisabledSchema()])
    .describe(
      "Controls Zy's thinking/reasoning behavior. When set, takes precedence over the deprecated maxThinkingTokens.",
    ),
)

// ============================================================================
// MCP Server Config Types (serializable only)
// ============================================================================

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(), // Optional for backwards compatibility
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpHttpServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)

export const McpServerConfigForProcessTransportSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpHttpServerConfigSchema(),
    McpSdkServerConfigSchema(),
  ]),
)

export const McpZyAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('zyai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)

// Broader config type for status responses (includes zyai-proxy which is output-only)
export const McpServerStatusConfigSchema = lazySchema(() =>
  z.union([McpServerConfigForProcessTransportSchema(), McpZyAIProxyServerConfigSchema()]),
)

export const McpServerStatusSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('Server name as configured'),
      status: z
        .enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
        .describe('Current connection status'),
      serverInfo: z
        .object({
          name: z.string(),
          version: z.string(),
        })
        .optional()
        .describe('Server information (available when connected)'),
      error: z.string().optional().describe("Error message (available when status is 'failed')"),
      config: McpServerStatusConfigSchema()
        .optional()
        .describe('Server configuration (includes URL for HTTP/SSE servers)'),
      scope: z
        .string()
        .optional()
        .describe('Configuration scope (e.g., project, user, local, zyai, managed)'),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            annotations: z
              .object({
                readOnly: z.boolean().optional(),
                destructive: z.boolean().optional(),
                openWorld: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .optional()
        .describe('Tools provided by this server (available when connected)'),
      capabilities: z
        .object({
          experimental: z.record(z.string(), z.unknown()).optional(),
        })
        .optional()
        .describe(
          "@internal Server capabilities (available when connected). experimental['zy/channel'] is only present if the server's plugin is on the approved channels allowlist — use its presence to decide whether to show an Enable-channel prompt.",
        ),
    })
    .describe('Status information for an MCP server connection.'),
)

export const McpSetServersResultSchema = lazySchema(() =>
  z
    .object({
      added: z.array(z.string()).describe('Names of servers that were added'),
      removed: z.array(z.string()).describe('Names of servers that were removed'),
      errors: z
        .record(z.string(), z.string())
        .describe('Map of server names to error messages for servers that failed to connect'),
    })
    .describe('Result of a setMcpServers operation.'),
)

// ============================================================================
// Permission Types
// ============================================================================

export const PermissionUpdateDestinationSchema = lazySchema(() =>
  z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
)

export const PermissionBehaviorSchema = lazySchema(() => z.enum(['allow', 'deny', 'ask']))

export const PermissionRuleValueSchema = lazySchema(() =>
  z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  }),
)

export const PermissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('setMode'),
      mode: z.lazy(() => PermissionModeSchema()),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()),
      destination: PermissionUpdateDestinationSchema(),
    }),
  ]),
)

export const PermissionDecisionClassificationSchema = lazySchema(() =>
  z
    .enum(['user_temporary', 'user_permanent', 'user_reject'])
    .describe(
      'Classification of this permission decision for telemetry. SDK hosts ' +
        'that prompt users (desktop apps, IDEs) should set this to reflect ' +
        'what actually happened: user_temporary for allow-once, user_permanent ' +
        'for always-allow (both the click and later cache hits), user_reject ' +
        'for deny. If unset, the CLI infers conservatively (temporary for ' +
        'allow, reject for deny). The vocabulary matches tool_decision OTel ' +
        'events (monitoring-usage docs).',
    ),
)

export const PermissionResultSchema = lazySchema(() =>
  z.union([
    z.object({
      behavior: z.literal('allow'),
      // Optional - may not be provided if hook sets permission without input modification
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
      toolUseID: z.string().optional(),
      decisionClassification: PermissionDecisionClassificationSchema().optional(),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional(),
      toolUseID: z.string().optional(),
      decisionClassification: PermissionDecisionClassificationSchema().optional(),
    }),
  ]),
)

export const PermissionModeSchema = lazySchema(() =>
  z
    .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])
    .describe(
      'Permission mode for controlling how tool executions are handled. ' +
        "'default' - Standard behavior, prompts for dangerous operations. " +
        "'acceptEdits' - Auto-accept file edit operations. " +
        "'bypassPermissions' - Bypass all permission checks (requires allowDangerouslySkipPermissions). " +
        "'plan' - Planning mode, no actual tool execution. " +
        "'dontAsk' - Don't prompt for permissions, deny if not pre-approved.",
    ),
)

// ============================================================================
// Skill/Command Types
// ============================================================================

export const SlashCommandSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('Skill name (without the leading slash)'),
      description: z.string().describe('Description of what the skill does'),
      argumentHint: z.string().describe('Hint for skill arguments (e.g., "<file>")'),
    })
    .describe('Information about an available skill (invoked via /command syntax).'),
)

export const AgentInfoSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('Agent type identifier (e.g., "Explore")'),
      description: z.string().describe('Description of when to use this agent'),
      model: z
        .string()
        .optional()
        .describe("Model alias this agent uses. If omitted, inherits the parent's model"),
    })
    .describe('Information about an available subagent that can be invoked via the Task tool.'),
)

export const ModelInfoSchema = lazySchema(() =>
  z
    .object({
      value: z.string().describe('Model identifier to use in API calls'),
      displayName: z.string().describe('Human-readable display name'),
      description: z.string().describe("Description of the model's capabilities"),
      supportsEffort: z.boolean().optional().describe('Whether this model supports effort levels'),
      supportedEffortLevels: z
        .array(z.enum(['off', 'quick', 'light', 'balanced', 'thorough', 'extreme']))
        .optional()
        .describe('Available effort levels for this model'),
      supportsAdaptiveThinking: z
        .boolean()
        .optional()
        .describe(
          'Whether this model supports adaptive thinking (Zy decides when and how much to think)',
        ),
      supportsAutoMode: z.boolean().optional().describe('Whether this model supports auto mode'),
    })
    .describe('Information about an available model.'),
)

export const AccountInfoSchema = lazySchema(() =>
  z
    .object({
      email: z.string().optional(),
      organization: z.string().optional(),
      subscriptionType: z.string().optional(),
      tokenSource: z.string().optional(),
      apiKeySource: z.string().optional(),
      apiProvider: z
        .enum(['anthropic', 'bedrock', 'vertex', 'foundry', 'dashscope', 'openrouter', 'generic'])
        .optional()
        .describe(
          'Active API backend. Anthropic OAuth login only applies when "anthropic"; for 3P providers the other fields are absent and auth is external (AWS creds, gcloud ADC, etc.).',
        ),
    })
    .describe("Information about the logged in user's account."),
)

// ============================================================================
// Agent Definition Types
// ============================================================================

export const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([z.string(), z.record(z.string(), McpServerConfigForProcessTransportSchema())]),
)

export const AgentDefinitionSchema = lazySchema(() =>
  z
    .object({
      description: z.string().describe('Natural language description of when to use this agent'),
      tools: z
        .array(z.string())
        .optional()
        .describe('Array of allowed tool names. If omitted, inherits all tools from parent'),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe('Array of tool names to explicitly disallow for this agent'),
      prompt: z.string().describe("The agent's system prompt"),
      model: z
        .string()
        .optional()
        .describe(
          "Model tier (e.g. 'standard', 'advanced', 'compact') or full model ID (e.g. 'qwen3.6-plus'). If omitted or 'inherit', uses the main model",
        ),
      mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
      criticalSystemReminder_EXPERIMENTAL: z
        .string()
        .optional()
        .describe('Experimental: Critical reminder added to system prompt'),
      skills: z
        .array(z.string())
        .optional()
        .describe('Array of skill names to preload into the agent context'),
      initialPrompt: z
        .string()
        .optional()
        .describe(
          'Auto-submitted as the first user turn when this agent is the main thread agent. Slash commands are processed. Prepended to any user-provided prompt.',
        ),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of agentic turns (API round-trips) before stopping'),
      background: z
        .boolean()
        .optional()
        .describe(
          'Run this agent as a background task (non-blocking, fire-and-forget) when invoked',
        ),
      memory: z
        .enum(['user', 'project', 'local'])
        .optional()
        .describe(
          "Scope for auto-loading agent memory files. 'user' - ~/.zy/agent-memory/<agentType>/, 'project' - .zy/agent-memory/<agentType>/, 'local' - .zy/agent-memory-local/<agentType>/",
        ),
      effort: z
        .union([z.enum(['quick', 'light', 'balanced', 'thorough', 'extreme']), z.number().int()])
        .optional()
        .describe('Reasoning effort level for this agent. Either a named level or an integer'),
      permissionMode: PermissionModeSchema()
        .optional()
        .describe('Permission mode controlling how tool executions are handled'),
    })
    .describe('Definition for a custom subagent that can be invoked via the Agent tool.'),
)

// ============================================================================
// Settings Types
// ============================================================================

export const SettingSourceSchema = lazySchema(() =>
  z
    .enum(['user', 'project', 'local'])
    .describe(
      'Source for loading filesystem-based settings. ' +
        "'user' - Global user settings (~/.zy/settings.json). " +
        "'project' - Project settings (.zy/settings.json). " +
        "'local' - Local settings (.zy/settings.local.json).",
    ),
)

export const SdkPluginConfigSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('local').describe("Plugin type. Currently only 'local' is supported"),
      path: z.string().describe('Absolute or relative path to the plugin directory'),
    })
    .describe('Configuration for loading a plugin.'),
)

// ============================================================================
// Rewind Types
// ============================================================================

export const RewindFilesResultSchema = lazySchema(() =>
  z
    .object({
      canRewind: z.boolean(),
      error: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      insertions: z.number().optional(),
      deletions: z.number().optional(),
    })
    .describe('Result of a rewindFiles operation.'),
)
