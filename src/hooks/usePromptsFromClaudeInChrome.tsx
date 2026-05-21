import { useEffect, useRef } from 'react'
import { z } from 'zod/v4'
import { callIdeRpc } from '../services/mcp/mcpToolCall.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'
// @ts-expect-error
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from '../utils/ClaudeInChrome/common.js'
import { lazySchema } from '../utils/lazySchema.js'

// Schema for the prompt notification from Chrome extension (JSON-RPC 2.0 format)
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
 * A hook that listens for prompt notifications from the Zy for Chrome extension,
 * enqueues them as user prompts, and syncs permission mode changes to the extension.
 */
export function usePromptsFromClaudeInChrome(mcpClients, toolPermissionMode) {
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
