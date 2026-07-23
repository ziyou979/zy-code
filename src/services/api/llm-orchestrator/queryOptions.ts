/**
 * Options 类型，从 nonStreaming.ts 提取为唯一来源。
 */
import type { Notification } from '../../../context/notifications.js'
import type { AgentId } from '../../../types/ids.js'
import type { QuerySource } from '../../../constants/querySource.js'
import type {
  JSONOutputFormat,
  ProviderExtras,
  ToolChoice,
  ToolDefinition,
} from '../../../types/llm.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { QueryChainTracking, ToolPermissionContext, Tools } from '../../../tools/tool.js'
import type { EffortLevel } from '../../../services/effort/effort.js'
import type { ThinkingConfig } from '../../../services/messages/thinking.js'

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: ToolChoice | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: ToolDefinition[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: (url: RequestInfo, init?: RequestInit) => Promise<Response>
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortLevel
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId
  outputFormat?: JSONOutputFormat
  addNotification?: (notif: Notification) => void
  providerExtras?: ProviderExtras
  taskBudget?: { total: number; remaining?: number }
}
