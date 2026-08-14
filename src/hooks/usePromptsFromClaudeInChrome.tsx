import { useEffect, useRef } from 'react'
import { z } from 'zod/v4'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from '../services/claude-in-chrome/common.js'
import { callIdeRpc } from '../services/mcp/mcpToolCall.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'
import { lazySchema } from '../utils/lazySchema.js'

// Chrome 扩展 prompt 通知的 schema（JSON-RPC 2.0 格式）
const _ClaudeInChromePromptNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/message'),
    params: z.object({
      prompt: z.string(),
      image: z
        .object({
          type: z.literal('base64'),
          mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
          data: z.string(),
        })
        .optional(),
      tabId: z.number().optional(),
    }),
  }),
)

/**
 * 监听 Zy for Chrome 扩展的 prompt 通知，将其作为用户 prompt 入队，
 * 并向扩展同步权限模式变化。
 */
export function usePromptsFromClaudeInChrome(
  mcpClients: MCPServerConnection[],
  toolPermissionMode: string,
) {
  useRef(undefined)
  useEffect(_temp, [])
  useEffect(() => {
    const chromeClient = findChromeClient(mcpClients)
    if (!chromeClient) {
      return
    }
    const chromeMode =
      toolPermissionMode === 'bypassPermissions' ? 'skip_all_permission_checks' : 'ask'
    callIdeRpc(
      'set_permission_mode',
      {
        mode: chromeMode,
      },
      chromeClient,
    )
  }, [mcpClients, toolPermissionMode])
}
function _temp() {}
function findChromeClient(clients: MCPServerConnection[]): ConnectedMCPServer | undefined {
  return clients.find(
    (client): client is ConnectedMCPServer =>
      client.type === 'connected' && client.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  )
}
