// 流式思考 state + 30 秒自动隐藏 effect。
// 抽自 screens/REPL.tsx 717-731：当 streamingThinking 已结束 streaming（设置了
// streamingEndedAt）且不再 isStreaming，在 30s 后自动清掉，避免思考小框留屏。
// 调用方仍可通过返回的 setStreamingThinking 手动写入（stream 处理路径 / 取消等）。

import { useEffect, useState } from 'react'
import type { StreamingThinking } from '../../utils/messages.js'

const AUTO_HIDE_AFTER_MS = 30000

export type StreamingThinkingApi = {
  streamingThinking: StreamingThinking | null
  setStreamingThinking: React.Dispatch<React.SetStateAction<StreamingThinking | null>>
}

export function useStreamingThinking(): StreamingThinkingApi {
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null)

  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt
      const remaining = AUTO_HIDE_AFTER_MS - elapsed
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null)
        return () => clearTimeout(timer)
      }
      setStreamingThinking(null)
    }
  }, [streamingThinking])

  return { streamingThinking, setStreamingThinking }
}
