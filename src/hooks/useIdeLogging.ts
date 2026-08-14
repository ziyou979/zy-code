import { useEffect } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../services/ide/ide.js'
import { lazySchema } from '../utils/lazySchema.js'

const LogEventSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

export function useIdeLogging(mcpClients: MCPServerConnection[]): void {
  useEffect(() => {
    // 没有 client 时跳过
    if (!mcpClients.length) {
      return
    }

    // 从 MCP client 列表中查找 IDE client
    const ideClient = getConnectedIdeClient(mcpClients)
    if (ideClient) {
      // 注册日志事件处理器
      ideClient.client.setNotificationHandler(LogEventSchema(), (notification) => {
        const { eventName, eventData } = notification.params
        logEvent(
          `zy_ide_${eventName}`,
          eventData as { [key: string]: boolean | number | undefined },
        )
      })
    }
  }, [mcpClients])
}
