// 对话标识：每次回合开始 / clear / 恢复时重新生成，用作 Messages.tsx
// 行键的命名空间，让消息切片在跨回合滚屏中不混淆。
//
// 抽自 screens/REPL.tsx 1240。
//
// 提供两条 setter 路径：
// - regenerate()：等价于 setConversationId(randomUUID())，覆盖回合结束 /
//   /clear / restore 等多个就地 randomUUID() 调用，统一语义
// - setConversationId：保留原 setter 给 sessionId 显式切换路径（恢复时
//   想用对方 sessionId 而非新 UUID）

import { useCallback, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type React from 'react'

export type ReplConversationId = {
  conversationId: string
  setConversationId: React.Dispatch<React.SetStateAction<string>>
  /** 生成新 UUID 写入 — 回合结束 / clear / restore 路径用 */
  regenerateConversationId: () => void
}

export function useReplConversationId(): ReplConversationId {
  const [conversationId, setConversationId] = useState(randomUUID())
  const regenerateConversationId = useCallback(() => {
    setConversationId(randomUUID())
  }, [])
  return { conversationId, setConversationId, regenerateConversationId }
}
