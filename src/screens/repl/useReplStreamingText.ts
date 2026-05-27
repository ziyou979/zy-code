// 流式文本显示状态 + 派生。
// 抽自 screens/REPL.tsx 1232-1255：
// - streamingText useState：每个 delta 直接 setState（Ink 16ms 渲染节流批处理
//   快速更新）；消息到达时由 messages.ts 清除，displayedMessages 从
//   deferredMessages 原子切到 messages
// - showStreamingText：reducedMotion 关闭 + 终端不存在 cursor-up viewport
//   yank bug 时为 true
// - onStreamingText：guarded setter — showStreamingText=false 直接吞掉调用，
//   避免 reducedMotion 用户仍触发 setState 重渲染
// - visibleStreamingText：取最后换行前的部分，让逐行（而非逐字符）流式
//   出现；showStreamingText 在派生上再守一次，使中途切 reducedMotion 立即隐藏
//
// REPL 主体仍需 setStreamingText（onCancel 路径把 streamingText 推入
// messages、resetLoadingState 清空），所以 setter 一并 export。

import { useCallback, useState } from 'react'
import { hasCursorUpViewportYankBug } from '../../ink/terminal.js'
import { useAppState } from '../../state/AppState.js'

export type ReplStreamingText = {
  streamingText: string | null
  setStreamingText: React.Dispatch<React.SetStateAction<string | null>>
  onStreamingText: (f: (current: string | null) => string | null) => void
  visibleStreamingText: string | null
  /**
   * Messages 走同步路径（非 deferredValue）的判定基础之一：
   * 当流式文本可见时，让最终消息与 streamingText 清空同帧到达，避免闪烁。
   */
  showStreamingText: boolean
}

export function useReplStreamingText(): ReplStreamingText {
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const reducedMotion = useAppState((s) => s.settings.prefersReducedMotion) ?? false
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug()

  const onStreamingText = useCallback(
    (f: (current: string | null) => string | null) => {
      if (!showStreamingText) {
        return
      }
      setStreamingText(f)
    },
    [showStreamingText],
  )

  const visibleStreamingText =
    streamingText && showStreamingText
      ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
      : null

  return {
    streamingText,
    setStreamingText,
    onStreamingText,
    visibleStreamingText,
    showStreamingText,
  }
}
