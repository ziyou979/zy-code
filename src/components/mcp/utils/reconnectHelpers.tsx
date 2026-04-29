import { tSync } from 'src/i18n/index.js';
import type { Command } from '../../../commands.js';
import type { MCPServerConnection, ServerResource } from '../../../services/mcp/types.js';
import type { Tool } from '../../../Tool.js';
export interface ReconnectResult {
  message: string;
  success: boolean;
}

/**
 * 处理重新连接尝试的结果并返回适当的用户消息
 */
export function handleReconnectResult(result: {
  client: MCPServerConnection;
  tools: Tool[];
  commands: Command[];
  resources?: ServerResource[];
}, serverName: string): ReconnectResult {
  switch (result.client.type) {
    case 'connected':
      return {
        message: tSync('mcp.reconnectedTo', { serverName }),
        success: true
      };
    case 'needs-auth':
      return {
        message: tSync('mcp.requiresAuthOption', { serverName }),
        success: false
      };
    case 'failed':
      return {
        message: tSync('mcp.failedToReconnectTo', { serverName }),
        success: false
      };
    default:
      return {
        message: tSync('mcp.unknownReconnectResult', { serverName }),
        success: false
      };
  }
}

/**
 * 处理重新连接尝试的错误
 */
export function handleReconnectError(error: unknown, serverName: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return tSync('mcp.errorReconnecting', { serverName, error: errorMessage });
}
