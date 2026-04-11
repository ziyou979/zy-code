// Tool Types - shared type definitions for tools.

import type {
  NormalizedMessage,
  NormalizedUserMessage,
} from './message.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

// ============================================================
// Shell Progress (Bash / PowerShell)
// ============================================================

export type ShellProgress = {
  type: 'bash_progress' | 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId: string | undefined
  timeoutMs: number
}

export type BashProgress = ShellProgress

export type PowerShellProgress = ShellProgress

// ============================================================
// MCP Progress
// ============================================================

export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'completed' | 'failed' | 'progress'
  serverName: string
  toolName: string
  elapsedTimeMs?: number
  progress?: number
  total?: number
  progressMessage?: string
}

// ============================================================
// Agent Tool Progress
// ============================================================

export type AgentToolProgress = {
  type: 'agent_progress'
  message: NormalizedUserMessage
  prompt: string
  agentId: string
}

// ============================================================
// Skill Tool Progress
// ============================================================

export type SkillToolProgress = {
  type: 'skill_progress'
  message: NormalizedMessage
  prompt: string
  agentId: string
}

// ============================================================
// Task Output Progress
// ============================================================

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: string
}

// ============================================================
// Web Search Progress
// ============================================================

export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }

// ============================================================
// REPL Tool Progress (placeholder — currently unused)
// ============================================================

export type REPLToolProgress = {
  type: 'repl_progress'
}

// ============================================================
// SDK Workflow Progress
// ============================================================

export type SdkWorkflowProgress = {
  type: string
  index: number
  phaseIndex?: number
  status?: string
  label?: string
  [key: string]: unknown
}

// ============================================================
// Union of all tool progress data types
// ============================================================

export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | MCPProgress
  | AgentToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress
  | REPLToolProgress
