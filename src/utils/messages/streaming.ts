// 流事件 → 消息累积逻辑。messages.ts 重新导出公开类型与入口。

import { feature } from 'bun:bundle'
import type { SpinnerMode } from '../../components/Spinner.js'
import { isConnectorTextBlock } from '../../types/connectorText.js'
import type { ToolCallBlock } from '../../types/llm.js'
import type {
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../../types/message.js'

/**
 * 从内容块数组中提取文本，用给定分隔符连接文本块。
 * 通过结构化类型兼容 ContentBlock 及其 readonly/DeepImmutable 变体。
 */
export type StreamingToolUse = {
  index: number
  contentBlock: ToolCallBlock
  unparsedToolInput: string
}

export type StreamingThinking = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}

/**
 * 处理来自流的消息，更新增量的响应长度并追加已完成的消息
 */
export function handleMessageFromStream(
  message: Message | TombstoneMessage | StreamEvent | RequestStartEvent | ToolUseSummaryMessage,
  onMessage: (message: Message) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: SpinnerMode) => void,
  onStreamingToolUses: (f: (streamingToolUse: StreamingToolUse[]) => StreamingToolUse[]) => void,
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: (
    f: (current: StreamingThinking | null) => StreamingThinking | null,
  ) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void {
  if (message.type !== 'stream_event' && message.type !== 'stream_request_start') {
    const _msg = message as Message | StreamEvent | RequestStartEvent | TombstoneMessage
    // 处理 tombstone 消息 — 移除目标消息而非添加
    if (message.type === 'system' && message.subtype === 'tombstone') {
      onTombstone?.(message.message)
      return
    }
    // Tool use summary 消息仅限 SDK，流处理中忽略它们
    if (message.type === 'tool_use_summary') {
      return
    }
    // 在 transcript 模式下捕获完整的 thinking 块用于实时显示
    if (message.type === 'assistant') {
      const content = message.message.content
      const thinkingBlock = Array.isArray(content)
        ? content.find((block) => block.type === 'thinking')
        : undefined
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        onStreamingThinking?.(() => ({
          thinking: thinkingBlock.thinking,
          isStreaming: false,
          streamingEndedAt: Date.now(),
        }))
      }
    }
    // 立即清除流式 text，使渲染能在同一批中将 displayedMessages
    // 从 deferredMessages 切换到 messages，让流式 text → 最终消息的
    // 过渡是原子的（无间隙、无重复）。
    onStreamingText?.(() => null)
    onMessage(message)
    return
  }

  if (message.type === 'stream_request_start') {
    onSetStreamMode('requesting')
    return
  }

  if (message.event.type === 'message_stop' || message.event.type === 'response_stop') {
    onSetStreamMode('tool-use')
    onStreamingToolUses(() => [])
    return
  }

  switch (message.event.type) {
    // 标准格式（adapter 转换后）
    case 'chunk_start': {
      onStreamingText?.(() => null)
      const startEvent = message.event as unknown as import('../../types/llm.js').ChunkStartEvent
      const chunk = startEvent.chunk
      if (!chunk) {
        return
      }
      if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(chunk)) {
        onSetStreamMode('responding')
        return
      }
      // chunk.type 可能包含扩展类型（server_tool_use 等），用 string 避免穷举
      const chunkType: string = chunk.type
      switch (chunkType) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use':
        case 'tool_call': {
          onSetStreamMode('tool-input')
          onStreamingToolUses((_) => [
            ..._,
            {
              index: startEvent.index,
              contentBlock: chunk as import('../../types/llm.js').ToolCallBlock,
              unparsedToolInput: '',
            },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    }
    case 'chunk_delta': {
      const deltaEvent = message.event as unknown as import('../../types/llm.js').ChunkDeltaEvent
      const delta = deltaEvent.delta
      if (!delta) {
        return
      }
      switch (delta.type) {
        case 'text_delta': {
          const deltaText = delta.text
          onUpdateLength(deltaText)
          onStreamingText?.((text) => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          const partialJson = delta.partialJson ?? ''
          onUpdateLength(partialJson)
          onStreamingToolUses((_) => {
            const element = _.find((_) => _.index === deltaEvent.index)
            if (!element) {
              return _
            }
            return [
              ..._.filter((_) => _ !== element),
              {
                ...element,
                unparsedToolInput: element.unparsedToolInput + partialJson,
              },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(delta.thinking)
          return
        case 'signature_delta':
          return
        default:
          return
      }
    }
    case 'chunk_stop':
      return
    case 'response_delta':
      onSetStreamMode('responding')
      return
    case 'response_start':
      return

    // 旧格式（向后兼容）
    case 'content_block_start':
      onStreamingText?.(() => null)
      if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(message.event.content_block)) {
        onSetStreamMode('responding')
        return
      }
      switch (message.event.content_block.type) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use': {
          onSetStreamMode('tool-input')
          const contentBlock = message.event.content_block
          const index = message.event.index ?? 0
          onStreamingToolUses((_) => [
            ..._,
            {
              index,
              contentBlock,
              unparsedToolInput: '',
            },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    case 'content_block_delta':
      switch (message.event.delta.type) {
        case 'text_delta': {
          const deltaText = message.event.delta.text
          onUpdateLength(deltaText)
          onStreamingText?.((text) => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          // 标准层统一使用驼峰 partialJson（见 types/llm.ts ToolCallInputDelta）
          const delta = message.event.delta.partialJson ?? ''
          const index = message.event.index
          onUpdateLength(delta)
          onStreamingToolUses((_) => {
            const element = _.find((_) => _.index === index)
            if (!element) {
              return _
            }
            return [
              ..._.filter((_) => _ !== element),
              {
                ...element,
                unparsedToolInput: element.unparsedToolInput + delta,
              },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(message.event.delta.thinking)
          return
        case 'signature_delta':
          // Signature 是加密认证字符串，不是模型输出。将其排除在 onUpdateLength 之外
          // 可防止它们膨胀 OTPS 指标和动画 token 计数器。
          return
        default:
          return
      }
    case 'content_block_stop':
      return
    case 'message_delta':
      onSetStreamMode('responding')
      return
    default:
      onSetStreamMode('responding')
      return
  }
}
