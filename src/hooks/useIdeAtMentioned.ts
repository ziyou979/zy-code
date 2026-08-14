import { useEffect, useRef } from 'react'
import { logError } from 'src/services/infra/log.js'
import { z } from 'zod/v4'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../services/ide/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
export type IDEAtMentioned = {
  filePath: string
  lineStart?: number
  lineEnd?: number
}

const NOTIFICATION_METHOD = 'at_mentioned'

const AtMentionedSchema = lazySchema(() =>
  z.object({
    method: z.literal(NOTIFICATION_METHOD),
    params: z.object({
      filePath: z.string(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
    }),
  }),
)

/**
 * 直接向 MCP client 注册通知处理器，用于跟踪 IDE at-mention 通知的 hook。
 */
export function useIdeAtMentioned(
  mcpClients: MCPServerConnection[],
  onAtMentioned: (atMentioned: IDEAtMentioned) => void,
): void {
  const ideClientRef = useRef<ConnectedMCPServer | undefined>(undefined)

  useEffect(() => {
    // 从 MCP client 列表中查找 IDE client
    const ideClient = getConnectedIdeClient(mcpClients)

    if (ideClientRef.current !== ideClient) {
      ideClientRef.current = ideClient
    }

    // 找到已连接的 IDE client 后注册处理器
    if (ideClient) {
      ideClient.client.setNotificationHandler(AtMentionedSchema(), (notification) => {
        if (ideClientRef.current !== ideClient) {
          return
        }
        try {
          const data = notification.params
          // 将行号从 0-based 调整为 1-based
          const lineStart = data.lineStart !== undefined ? data.lineStart + 1 : undefined
          const lineEnd = data.lineEnd !== undefined ? data.lineEnd + 1 : undefined
          onAtMentioned({
            filePath: data.filePath,
            lineStart: lineStart,
            lineEnd: lineEnd,
          })
        } catch (error) {
          logError(error as Error)
        }
      })
    }

    // MCP client 会管理自身生命周期，此处无需清理
  }, [mcpClients, onAtMentioned])
}
