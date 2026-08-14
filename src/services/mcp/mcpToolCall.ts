import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  CallToolResultSchema,
  type ElicitRequestURLParams,
  type ElicitResult,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { AssistantMessage } from 'src/types/message.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { MCPProgress } from '../../tools/MCPTool/MCPTool.js'
import type { ContentBlock } from '../../types/llm.js'
import { createAbortController } from '../../utils/abortController.js'
import { detectCodeIndexingFromMcpServerName } from '../../services/search/codeIndexing.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { logMCPDebug, logMCPError } from '../../services/infra/log.js'
import type { MCPToolResult } from '../mcp/mcpValidation.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { clearServerCache } from './client.js'
import {
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from './elicitationHandler.js'
import { processMCPResult } from './mcpResults.js'
import {
  getMcpToolTimeoutMs,
  isMcpSessionExpiredError,
  McpAuthError,
  McpSessionExpiredError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from './mcpShared.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'

export type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

/**
 * 以 RPC 形式直接调用 IDE tool。
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlock[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}

/** @internal 为测试而导出。 */
export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
}): Promise<MCPToolCallResult> {
  const MAX_URL_ELICITATION_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await callToolFn({
        client: connectedClient,
        tool,
        args,
        meta,
        signal,
        onProgress,
      })
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== ErrorCode.UrlElicitationRequired) {
        throw error
      }

      if (attempt >= MAX_URL_ELICITATION_RETRIES) {
        throw error
      }

      const errorData = error.data
      const rawElicitations =
        errorData != null &&
        typeof errorData === 'object' &&
        'elicitations' in errorData &&
        Array.isArray(errorData.elicitations)
          ? (errorData.elicitations as unknown[])
          : []

      const elicitations = rawElicitations.filter((e): e is ElicitRequestURLParams => {
        if (e == null || typeof e !== 'object') {
          return false
        }
        const obj = e as Record<string, unknown>
        return (
          obj.mode === 'url' &&
          typeof obj.url === 'string' &&
          typeof obj.elicitationId === 'string' &&
          typeof obj.message === 'string'
        )
      })

      const serverName = clientConnection.type === 'connected' ? clientConnection.name : 'unknown'

      if (elicitations.length === 0) {
        logMCPDebug(
          serverName,
          `Tool '${tool}' returned -32042 but no valid elicitations in error data`,
        )
        throw error
      }

      logMCPDebug(
        serverName,
        `Tool '${tool}' requires URL elicitation (error -32042, attempt ${attempt + 1}), processing ${elicitations.length} elicitation(s)`,
      )

      for (const elicitation of elicitations) {
        const { elicitationId } = elicitation

        const hookResponse = await runElicitationHooks(serverName, elicitation, signal)
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `URL elicitation ${elicitationId} resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          if (hookResponse.action !== 'accept') {
            return {
              content: `URL elicitation was ${hookResponse.action === 'decline' ? 'declined' : `${hookResponse.action}ed`} by a hook. The tool "${tool}" could not complete because it requires the user to open a URL.`,
            }
          }
          continue
        }

        let userResult: ElicitResult
        if (handleElicitation) {
          userResult = await handleElicitation(serverName, elicitation, signal)
        } else {
          const waitingState: ElicitationWaitingState = {
            actionLabel: 'Retry now',
            showCancel: true,
          }
          userResult = await new Promise<ElicitResult>((resolve) => {
            const onAbort = () => {
              void resolve({ action: 'cancel' })
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            setAppState((prev) => ({
              ...prev,
              elicitation: {
                queue: [
                  ...prev.elicitation.queue,
                  {
                    serverName,
                    requestId: `error-elicit-${elicitationId}`,
                    params: elicitation,
                    signal,
                    waitingState,
                    respond: (result) => {
                      if (result.action === 'accept') {
                        return
                      }
                      signal.removeEventListener('abort', onAbort)
                      void resolve(result)
                    },
                    onWaitingDismiss: (action) => {
                      signal.removeEventListener('abort', onAbort)
                      if (action === 'retry') {
                        void resolve({ action: 'accept' })
                      } else {
                        void resolve({ action: 'cancel' })
                      }
                    },
                  },
                ],
              },
            }))
          })
        }

        const finalResult = await runElicitationResultHooks(
          serverName,
          userResult,
          signal,
          'url',
          elicitationId,
        )

        if (finalResult.action !== 'accept') {
          logMCPDebug(
            serverName,
            `User ${finalResult.action === 'decline' ? 'declined' : `${finalResult.action}ed`} URL elicitation ${elicitationId}`,
          )
          return {
            content: `URL elicitation was ${finalResult.action === 'decline' ? 'declined' : `${finalResult.action}ed`} by the user. The tool "${tool}" could not complete because it requires the user to open a URL.`,
          }
        }

        logMCPDebug(serverName, `Elicitation ${elicitationId} completed, retrying tool call`)
      }
    }
  }
}

export async function callMCPTool({
  client: { client, name, config },
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const toolStartTime = Date.now()
  let progressInterval: NodeJS.Timeout | undefined

  try {
    logMCPDebug(name, `Calling MCP tool: ${tool}`)

    progressInterval = setInterval(
      (startTime, name, tool) => {
        const elapsed = Date.now() - startTime
        const elapsedSeconds = Math.floor(elapsed / 1000)
        const duration = `${elapsedSeconds}s`
        logMCPDebug(name, `Tool '${tool}' still running (${duration} elapsed)`)
      },
      30000,
      toolStartTime,
      name,
      tool,
    )

    const timeoutMs = getMcpToolTimeoutMs()
    let timeoutId: NodeJS.Timeout | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        (reject, name, tool, timeoutMs) => {
          reject(
            new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
              'MCP tool timeout',
            ),
          )
        },
        timeoutMs,
        reject,
        name,
        tool,
        timeoutMs,
      )
    })

    const result = await Promise.race([
      client.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        CallToolResultSchema,
        {
          signal,
          timeout: timeoutMs,
          onprogress: onProgress
            ? (sdkProgress) => {
                onProgress({
                  type: 'mcp_progress',
                  status: 'progress',
                  serverName: name,
                  toolName: tool,
                  progress: sdkProgress.progress,
                  total: sdkProgress.total,
                  progressMessage: sdkProgress.message,
                })
              }
            : undefined,
        },
      ),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    })

    if ('isError' in result && result.isError) {
      let errorDetails = 'Unknown error'
      if ('content' in result && Array.isArray(result.content) && result.content.length > 0) {
        const firstContent = result.content[0]
        if (firstContent && typeof firstContent === 'object' && 'text' in firstContent) {
          errorDetails = firstContent.text
        }
      } else if ('error' in result) {
        errorDetails = String(result.error)
      }
      logMCPError(name, errorDetails)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        errorDetails,
        'MCP tool returned error',
        '_meta' in result && result._meta ? { _meta: result._meta } : undefined,
      )
    }
    const elapsed = Date.now() - toolStartTime
    const duration =
      elapsed < 1000
        ? `${elapsed}ms`
        : elapsed < 60000
          ? `${Math.floor(elapsed / 1000)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`

    logMCPDebug(name, `Tool '${tool}' completed successfully in ${duration}`)

    const codeIndexingTool = detectCodeIndexingFromMcpServerName(name)
    if (codeIndexingTool) {
      logEvent('zy_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source: 'mcp' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
      })
    }

    const content = await processMCPResult(result, tool, name)
    return {
      content,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as Record<string, unknown> | undefined,
    }
  } catch (e) {
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    const elapsed = Date.now() - toolStartTime

    if (e instanceof Error && e.name !== 'AbortError') {
      logMCPDebug(name, `Tool '${tool}' failed after ${Math.floor(elapsed / 1000)}s: ${e.message}`)
    }

    if (e instanceof Error) {
      const errorCode = 'code' in e ? (e.code as number | undefined) : undefined
      if (errorCode === 401 || e instanceof UnauthorizedError) {
        logMCPDebug(name, `Tool call returned 401 Unauthorized - token may have expired`)
        logEvent('zy_mcp_tool_call_auth_error', {})
        // 清除连接缓存，触发下次调用时重新初始化（复用 OAuth refresh）
        try {
          const { clearServerCache: clearCache } = await import('./client.js')
          await clearCache(name, config)
        } catch {
          // 动态导入或缓存清理失败不影响整体流程
        }
        throw new McpSessionExpiredError(name)
      }

      const isSessionExpired = isMcpSessionExpiredError(e)
      const isConnectionClosedOnHttp =
        'code' in e &&
        (e as Error & { code?: number }).code === -32000 &&
        e.message.includes('Connection closed') &&
        (config.type === 'http' || config.type === 'zyai-proxy')
      if (isSessionExpired || isConnectionClosedOnHttp) {
        logMCPDebug(
          name,
          `MCP session expired during tool call (${isSessionExpired ? '404/-32001' : 'connection closed'}), clearing connection cache for re-initialization`,
        )
        logEvent('zy_mcp_session_expired', {})
        await clearServerCache(name, config)
        throw new McpSessionExpiredError(name)
      }
    }

    if (!(e instanceof Error) || e.name !== 'AbortError') {
      throw e
    }
    return { content: undefined }
  } finally {
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
  }
}

export function extractToolUseId(message: AssistantMessage): string | undefined {
  const content = message.message.content
  if (content.length === 0) {
    return undefined
  }
  const firstBlock = content[0]
  if (firstBlock.type !== 'tool_call') {
    return undefined
  }
  return firstBlock.id
}
