import { randomUUID } from 'node:crypto'
import type { Tool } from '../tools/tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { WireControlPermissionRequest } from '../types/wire/control.js'
import { jsonStringify } from '../services/infra/slowOperations.js'

/**
 * 为远程权限请求创建合成的 AssistantMessage。
 * ToolUseConfirm 类型要求提供 AssistantMessage，但远程模式没有真实消息，
 * 因为工具实际运行在 CCR 容器中。
 */
export function createSyntheticAssistantMessage(
  request: WireControlPermissionRequest,
  requestId: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      id: `remote-${requestId}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          id: request.tool_use_id,
          name: request.tool_name,
          input: request.input,
        },
      ],
      model: '',
      stopReason: null,
      container: null,
      context_management: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    } as AssistantMessage['message'],
    requestId: undefined,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 为本地未加载的工具创建最小 Tool 替身。
 * 当远程 CCR 拥有本地 CLI 不认识的工具（例如 MCP 工具）时会走此路径，
 * 该替身会将请求交给 FallbackPermissionRequest。
 */
export function createToolStub(toolName: string): Tool {
  return {
    name: toolName,
    inputSchema: {} as Tool['inputSchema'],
    isEnabled: () => true,
    userFacingName: () => toolName,
    renderToolUseMessage: (input: Record<string, unknown>) => {
      const entries = Object.entries(input)
      if (entries.length === 0) {
        return ''
      }
      return entries
        .slice(0, 3)
        .map(([key, value]) => {
          const valueStr = typeof value === 'string' ? value : jsonStringify(value)
          return `${key}: ${valueStr}`
        })
        .join(', ')
    },
    call: async () => ({ data: '' }),
    description: async () => '',
    prompt: () => '',
    isReadOnly: () => false,
    isMcp: false,
    needsPermissions: () => true,
  } as unknown as Tool
}
