/**
 * Auto-generated TypeScript types from Zod schemas in coreSchemas.ts.
 *
 * DO NOT EDIT MANUALLY.
 * To regenerate: bun scripts/generate-sdk-types.ts
 */

// ============================================================================
// Usage & Model Types
// ============================================================================

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

// ============================================================================
// Output Format Types
// ============================================================================

export type OutputFormatType = 'json_schema'

export interface BaseOutputFormat {
  type: OutputFormatType
}

export interface JsonSchemaOutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

export type OutputFormat = JsonSchemaOutputFormat

// ============================================================================
// Config Types
// ============================================================================

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth'

export type ConfigScope = 'local' | 'user' | 'project'

export interface ThinkingAdaptive {
  type: 'adaptive'
}

export interface ThinkingEnabled {
  type: 'enabled'
  budgetTokens?: number
}

export interface ThinkingDisabled {
  type: 'disabled'
}

export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled

// ============================================================================
// MCP Server Config Types
// ============================================================================

export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSSEServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export interface McpSdkServerConfig {
  type: 'sdk'
  name: string
}

export type McpServerConfigForProcessTransport =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig

export interface McpZyAIProxyServerConfig {
  type: 'zyai-proxy'
  url: string
  id: string
}

export type McpServerStatusConfig = McpServerConfigForProcessTransport | McpZyAIProxyServerConfig

export interface McpServerStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
  config?: McpServerStatusConfig
  scope?: string
  tools?: Array<{
    name: string
    description?: string
    annotations?: {
      readOnly?: boolean
      destructive?: boolean
      openWorld?: boolean
    }
  }>
  capabilities?: {
    experimental?: Record<string, unknown>
  }
}

export interface McpSetServersResult {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

// ============================================================================
// Permission Types
// ============================================================================

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate =
  | {
      type: 'addRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'replaceRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: PermissionMode
      destination: PermissionUpdateDestination
    }
  | {
      type: 'addDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }

export type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject'

export type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }
  | {
      behavior: 'deny'
      message: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

// ============================================================================
// Prompt Types
// ============================================================================

export interface PromptRequestOption {
  key: string
  label: string
  description?: string
}

export interface PromptRequest {
  prompt: string
  message: string
  options: PromptRequestOption[]
}

export interface PromptResponse {
  prompt_response: string
  selected: string
}

// ============================================================================
// Skill/Command Types
// ============================================================================

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
}

export interface AgentInfo {
  name: string
  description: string
  model?: string
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('quick' | 'light' | 'balanced' | 'thorough' | 'extreme')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?:
    | 'anthropic'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'dashscope'
    | 'openrouter'
    | 'generic'
}

// ============================================================================
// Agent Definition Types
// ============================================================================

export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>

export interface AgentDefinition {
  description: string
  tools?: string[]
  disallowedTools?: string[]
  prompt: string
  model?: string
  mcpServers?: AgentMcpServerSpec[]
  criticalSystemReminder_EXPERIMENTAL?: string
  skills?: string[]
  initialPrompt?: string
  maxTurns?: number
  background?: boolean
  memory?: 'user' | 'project' | 'local'
  effort?: 'quick' | 'light' | 'balanced' | 'thorough' | 'extreme' | number
  permissionMode?: PermissionMode
}

// ============================================================================
// Settings Types
// ============================================================================

export type SettingSource = 'user' | 'project' | 'local'

export interface SdkPluginConfig {
  type: 'local'
  path: string
}

// ============================================================================
// Rewind Types
// ============================================================================

export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}
