import { tSync } from '../i18n/index.js'
import type {
  WireAssistantMessage,
  WireCompactBoundaryMessage,
  WireMessage,
  WirePartialAssistantMessage,
  WireResultMessage,
  WireStatusMessage,
  WireSystemMessage,
  WireToolProgressMessage,
} from '../types/index.js'
import type { LLMAssistantMessage } from '../types/llm.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
  SystemMessageLevel,
} from '../types/message.js'
import { logForDebugging } from '../services/infra/debug.js'
import { fromSDKCompactMetadata } from '../services/messages/mappers.js'
import { createUserMessage } from '../services/messages/./constructors.js'

/**
 * 将 CCR 的 WireMessage 转换为 REPL Message 类型。
 *
 * CCR 后端通过 WebSocket 发送 SDK 格式消息，而 REPL 渲染时需要内部 Message 类型；
 * 此适配器负责衔接两者。
 */

/**
 * 将 WireAssistantMessage 转换为 AssistantMessage。
 */
function convertAssistantMessage(msg: WireAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message as LLMAssistantMessage,
    uuid: msg.uuid,
    requestId: undefined,
    timestamp: new Date().toISOString(),
    error: msg.error,
  }
}

/**
 * 将流式 WirePartialAssistantMessage 转换为 StreamEvent。
 */
function convertStreamEvent(msg: WirePartialAssistantMessage): StreamEvent {
  return {
    type: 'stream_event',
    event: msg.event as StreamEvent['event'],
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 WireResultMessage 转换为 SystemMessage。
 */
function convertResultMessage(msg: WireResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success'
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error'
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: (isError ? 'warn' : 'info') as SystemMessageLevel,
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将初始化 WireSystemMessage 转换为 SystemMessage。
 */
function convertInitMessage(msg: WireSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 WireStatusMessage 转换为 SystemMessage。
 */
function convertStatusMessage(msg: WireStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null
  }

  return {
    type: 'system',
    subtype: 'informational',
    content: msg.status === 'compacting' ? tSync('spinner.compacting') : `Status: ${msg.status}`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 WireToolProgressMessage 转换为 SystemMessage。
 * 这里不用 ProgressMessage，因为 Progress 是复杂联合类型，需要 CCR 未提供的工具专属数据。
 */
function convertToolProgressMessage(msg: WireToolProgressMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} running for ${msg.elapsed_time_seconds}s…`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id,
  }
}

/**
 * 将 WireCompactBoundaryMessage 转换为 SystemMessage。
 */
function convertCompactBoundaryMessage(msg: WireCompactBoundaryMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    compactMetadata: fromSDKCompactMetadata(msg.compact_metadata),
  }
}

/**
 * WireMessage 的转换结果。
 */
export type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }

type ConvertOptions = {
  /** 将包含 tool_result 内容块的 user 消息转换为 UserMessage。
   * 用于直连模式：工具结果来自远程服务器，需要在本地渲染。
   * CCR 模式会忽略用户消息，因为该模式采用另一套处理方式。 */
  convertToolResults?: boolean
  /**
   * 将用户文本消息转换为用于展示的 UserMessage。转换历史事件时，用户输入的消息需要显示，
   * 因此会启用此选项。实时 WebSocket 模式下 REPL 已在本地加入这些消息，默认忽略即可。
   */
  convertUserTextMessages?: boolean
}

/**
 * 将 WireMessage 转换为 REPL 消息格式。
 */
export function convertSDKMessage(msg: WireMessage, opts?: ConvertOptions): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return { type: 'message', message: convertAssistantMessage(msg) }

    case 'user': {
      const content = msg.message?.content
      // 远程服务器返回的 tool result 消息需要转换，才能像本地结果一样渲染和折叠。
      // 通过内容形态（tool_result 块）判断；parent_tool_use_id 并不可靠：
      // agent 侧 normalizeMessage() 会将顶层 tool result 的该字段固定为 null，
      // 因此无法借此区分 tool result 与 prompt 回显。
      const isToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
      if (opts?.convertToolResults && isToolResult) {
        return {
          type: 'message',
          message: createUserMessage({
            content,
            toolUseResult: msg.tool_use_result,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
          }),
        }
      }
      // 转换历史事件时，需要渲染用户输入的消息（REPL 并未在本地添加这些消息）。
      // 此处跳过已在上方处理的 tool_result。
      if (opts?.convertUserTextMessages && !isToolResult) {
        if (typeof content === 'string' || Array.isArray(content)) {
          return {
            type: 'message',
            message: createUserMessage({
              content:
                typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content,
              toolUseResult: msg.tool_use_result,
              uuid: msg.uuid,
              timestamp: msg.timestamp,
            }),
          }
        }
      }
      // REPL 已在本地添加用户输入的消息（字符串内容）。CCR 模式会忽略全部
      // user 消息，因为该模式对 tool result 另有处理方式。
      return { type: 'ignored' }
    }

    case 'stream_event':
      return { type: 'stream_event', event: convertStreamEvent(msg) }

    case 'result':
      // 仅显示错误 result 消息；多轮会话中的成功结果属于冗余信息，
      // isLoading=false 已足以表明成功。
      if (msg.subtype !== 'success') {
        return { type: 'message', message: convertResultMessage(msg) }
      }
      return { type: 'ignored' }

    case 'system':
      if (msg.subtype === 'init') {
        return { type: 'message', message: convertInitMessage(msg) }
      }
      if (msg.subtype === 'status') {
        const statusMsg = convertStatusMessage(msg)
        return statusMsg ? { type: 'message', message: statusMsg } : { type: 'ignored' }
      }
      if (msg.subtype === 'compact_boundary') {
        return {
          type: 'message',
          message: convertCompactBoundaryMessage(msg),
        }
      }
      // hook_response 及其他 subtype。
      logForDebugging(`[messageAdapter] Ignoring system message subtype: ${msg.subtype}`)
      return { type: 'ignored' }

    case 'tool_progress':
      return { type: 'message', message: convertToolProgressMessage(msg) }

    case 'auth_status':
      // auth status 单独处理，不转换为展示消息。
      logForDebugging('[messageAdapter] Ignoring auth_status message')
      return { type: 'ignored' }

    case 'tool_use_summary':
      // tool use 摘要仅供 SDK 使用，不在 REPL 中显示。
      logForDebugging('[messageAdapter] Ignoring tool_use_summary message')
      return { type: 'ignored' }

    case 'rate_limit_event':
      // 限流事件仅供 SDK 使用，不在 REPL 中显示。
      logForDebugging('[messageAdapter] Ignoring rate_limit_event message')
      return { type: 'ignored' }

    default: {
      // 平稳忽略未知消息类型。后端可能先于客户端更新发送新类型；记录日志便于调试，
      // 同时避免崩溃或丢失会话。
      logForDebugging(`[messageAdapter] Unknown message type: ${(msg as { type: string }).type}`)
      return { type: 'ignored' }
    }
  }
}

/**
 * 检查 WireMessage 是否表示会话已结束。
 */
export function isSessionEndMessage(msg: WireMessage): boolean {
  return msg.type === 'result'
}

/**
 * 检查 WireResultMessage 是否表示执行成功。
 */
export function isSuccessResult(msg: WireResultMessage): boolean {
  return msg.subtype === 'success'
}

/**
 * 从成功的 WireResultMessage 中提取结果文本。
 */
export function getResultText(msg: WireResultMessage): string | null {
  if (msg.subtype === 'success') {
    return msg.result
  }
  return null
}
