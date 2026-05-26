// Transcript 视图的「冻结状态」：进入 transcript 时只记录长度（不克隆数组），
// 渲染时用切片视图避免新流入消息覆盖冻结边界。
// 抽自 screens/REPL.tsx 1196-1200 + 4711-4722 + 4785-4790。
//
// 仅暴露 enter / exit callback + transcriptMessages / transcriptStreamingToolUses 派生，
// 内部 useState 不外露 —— 调用方不应直接读写冻结状态。

import { useCallback, useState } from 'react'
import type { Message } from '../../types/message.js'
import type { StreamingToolUse } from '../../utils/messages.js'

export type UseFrozenTranscriptParams = {
  messages: Message[]
  streamingToolUses: StreamingToolUse[]
  /** 与 messages 同语义但走 useDeferredValue —— transcript 视图渲染数据源 */
  deferredMessages: Message[]
}

export type FrozenTranscriptApi = {
  handleEnterTranscript: () => void
  handleExitTranscript: () => void
  /** 冻结时为 deferredMessages 的前缀切片；未冻结时即 deferredMessages 本体 */
  transcriptMessages: Message[]
  /** 冻结时为 streamingToolUses 的前缀切片；未冻结时即原数组 */
  transcriptStreamingToolUses: StreamingToolUse[]
}

export function useFrozenTranscript({
  messages,
  streamingToolUses,
  deferredMessages,
}: UseFrozenTranscriptParams): FrozenTranscriptApi {
  // 转录模式的冻结状态 - 存储长度而不是克隆数组以提高内存效率
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number
    streamingToolUsesLength: number
  } | null>(null)

  // 进入转录模式时捕获冻结状态的回调
  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length,
    })
  }, [messages.length, streamingToolUses.length])

  // 退出转录模式时清除冻结状态的回调
  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null)
  }, [])

  // 使用冻结长度切片数组，避免克隆的内存开销
  const transcriptMessages = frozenTranscriptState
    ? deferredMessages.slice(0, frozenTranscriptState.messagesLength)
    : deferredMessages
  const transcriptStreamingToolUses = frozenTranscriptState
    ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength)
    : streamingToolUses

  return {
    handleEnterTranscript,
    handleExitTranscript,
    transcriptMessages,
    transcriptStreamingToolUses,
  }
}
