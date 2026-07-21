import { feature } from 'bun:bundle'
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js'
import { type Tool, type ToolCallProgress } from '../../../tools/tool.js'
import { type MCPProgress, MCPTool } from '../../../tools/MCPTool/MCPTool.js'
import { classifyMcpToolForCollapse } from '../../../tools/MCPTool/classifyForCollapse.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../../utils/errors.js'
import {
  getClaudeInChromeToolOverrides,
  getComputerUseToolOverrides,
} from '../toolOverrideRegistry.js'
import { MAX_MCP_DESCRIPTION_LENGTH, McpSessionExpiredError } from '../mcpShared.js'
import { buildMcpToolName } from '../mcpStringUtils.js'
import { callMCPToolWithUrlElicitationRetry, extractToolUseId } from '../mcpToolCall.js'
import type { ConnectedMCPServer } from '../types.js'
import { isClaudeInChromeMCPServer } from '../../claude-in-chrome/common.js'
import { isComputerUseMCPServer } from './authCache.js'

type McpToolDefinition = ListToolsResult['tools'][number]
type EnsureConnectedClient = (client: ConnectedMCPServer) => Promise<ConnectedMCPServer>

/**
 * Encode MCP tool input for the auto-mode security classifier.
 * Exported so the auto-mode eval scripts can mirror production encoding
 * for `mcp__*` tool stubs without duplicating this logic.
 */
export function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const keys = Object.keys(input)
  return keys.length > 0 ? keys.map((k) => `${k}=${String(input[k])}`).join(' ') : toolName
}

export function buildMcpTool({
  client,
  tool,
  skipPrefix,
  ensureConnectedClient,
}: {
  client: ConnectedMCPServer
  tool: McpToolDefinition
  skipPrefix: boolean
  ensureConnectedClient: EnsureConnectedClient
}): Tool {
  const fullyQualifiedName = buildMcpToolName(client.name, tool.name)

  return {
    ...MCPTool,
    name: skipPrefix ? tool.name : fullyQualifiedName,
    mcpInfo: { serverName: client.name, toolName: tool.name },
    isMcp: true,
    searchHint:
      typeof tool._meta?.['anthropic/searchHint'] === 'string'
        ? tool._meta['anthropic/searchHint'].replace(/\s+/g, ' ').trim() || undefined
        : undefined,
    alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
    async description() {
      return tool.description ?? ''
    },
    async prompt() {
      const desc = tool.description ?? ''
      return desc.length > MAX_MCP_DESCRIPTION_LENGTH
        ? `${desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [truncated]`
        : desc
    },
    isConcurrencySafe() {
      return tool.annotations?.readOnlyHint ?? false
    },
    isReadOnly() {
      return tool.annotations?.readOnlyHint ?? false
    },
    toAutoClassifierInput(input) {
      return mcpToolInputToAutoClassifierInput(input, tool.name)
    },
    isDestructive() {
      return tool.annotations?.destructiveHint ?? false
    },
    isOpenWorld() {
      return tool.annotations?.openWorldHint ?? false
    },
    isSearchOrReadCommand() {
      return classifyMcpToolForCollapse(client.name, tool.name)
    },
    inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
    async checkPermissions() {
      return {
        behavior: 'passthrough' as const,
        message: 'MCPTool requires permission.',
        suggestions: [
          {
            type: 'addRules' as const,
            rules: [
              {
                toolName: fullyQualifiedName,
                ruleContent: undefined,
              },
            ],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          },
        ],
      }
    },
    async call(
      args: Record<string, unknown>,
      context,
      _canUseTool,
      parentMessage,
      onProgress?: ToolCallProgress<MCPProgress>,
    ) {
      const toolUseId = parentMessage ? extractToolUseId(parentMessage) : undefined
      const meta = toolUseId ? { 'zycode/toolUseId': toolUseId } : {}

      if (onProgress && toolUseId) {
        onProgress({
          toolUseID: toolUseId,
          data: {
            type: 'mcp_progress',
            status: 'started',
            serverName: client.name,
            toolName: tool.name,
          },
        })
      }

      const startTime = Date.now()
      const MAX_SESSION_RETRIES = 3
      const SESSION_RETRY_DELAY_MS = 500
      for (let attempt = 0; ; attempt++) {
        try {
          const connectedClient = await ensureConnectedClient(client)
          const mcpResult = await callMCPToolWithUrlElicitationRetry({
            client: connectedClient,
            clientConnection: client,
            tool: tool.name,
            args,
            meta,
            signal: context.abortController.signal,
            setAppState: context.setAppState,
            onProgress:
              onProgress && toolUseId
                ? (progressData) => {
                    onProgress({
                      toolUseID: toolUseId,
                      data: progressData,
                    })
                  }
                : undefined,
            handleElicitation: context.handleElicitation,
          })

          if (onProgress && toolUseId) {
            onProgress({
              toolUseID: toolUseId,
              data: {
                type: 'mcp_progress',
                status: 'completed',
                serverName: client.name,
                toolName: tool.name,
                elapsedTimeMs: Date.now() - startTime,
              },
            })
          }

          return {
            data: mcpResult.content,
            ...((mcpResult._meta || mcpResult.structuredContent) && {
              mcpMeta: {
                ...(mcpResult._meta && {
                  _meta: mcpResult._meta,
                }),
                ...(mcpResult.structuredContent && {
                  structuredContent: mcpResult.structuredContent,
                }),
              },
            }),
          }
        } catch (error) {
          if (error instanceof McpSessionExpiredError && attempt < MAX_SESSION_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS))
            continue
          }

          if (onProgress && toolUseId) {
            onProgress({
              toolUseID: toolUseId,
              data: {
                type: 'mcp_progress',
                status: 'failed',
                serverName: client.name,
                toolName: tool.name,
                elapsedTimeMs: Date.now() - startTime,
              },
            })
          }

          if (
            error instanceof Error &&
            !(error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
          ) {
            const name = error.constructor.name
            if (name === 'Error') {
              throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                error.message,
                error.message.slice(0, 200),
              )
            }
            if (name === 'McpError' && 'code' in error && typeof error.code === 'number') {
              throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                error.message,
                `McpError ${error.code}`,
              )
            }
          }
          throw error
        }
      }
    },
    userFacingName() {
      const displayName = tool.annotations?.title || tool.name
      return `${client.name} - ${displayName} (MCP)`
    },
    ...(isClaudeInChromeMCPServer(client.name) &&
    (client.config.type === 'stdio' || !client.config.type)
      ? getClaudeInChromeToolOverrides(tool.name)
      : {}),
    ...getChicagoOverrides(client, tool.name),
  }
}

function getChicagoOverrides(client: ConnectedMCPServer, toolName: string) {
  if (!feature('CHICAGO_MCP')) {
    return {}
  }

  if (
    (client.config.type === 'stdio' || !client.config.type) &&
    typeof isComputerUseMCPServer === 'function' &&
    isComputerUseMCPServer(client.name)
  ) {
    return getComputerUseToolOverrides(toolName)
  }

  return {}
}
