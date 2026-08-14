import { useCallback, useEffect, useRef } from 'react'
import type { Message } from '../types/message.js'

/**
 * 管理延迟到达的 SessionStart hook 消息，使 REPL 可以立即渲染，
 * 无需等待约 500 毫秒的 hook 执行。
 *
 * promise 完成后异步注入 hook 消息。返回的回调应由 onSubmit 在首次 API 请求前调用，
 * 确保模型始终能看到 hook 上下文。
 */
export function useDeferredHookMessages(
  pendingHookMessages: Promise<Message[]> | undefined,
  setMessages: (action: React.SetStateAction<Message[]>) => void,
): () => Promise<void> {
  const pendingRef = useRef(pendingHookMessages ?? null)
  const resolvedRef = useRef(!pendingHookMessages)

  useEffect(() => {
    const promise = pendingRef.current
    if (!promise) {
      return
    }
    let cancelled = false
    promise.then((msgs) => {
      if (cancelled) {
        return
      }
      resolvedRef.current = true
      pendingRef.current = null
      if (msgs.length > 0) {
        setMessages((prev) => [...msgs, ...prev])
      }
    })
    return () => {
      cancelled = true
    }
  }, [setMessages])

  return useCallback(async () => {
    if (resolvedRef.current || !pendingRef.current) {
      return
    }
    const msgs = await pendingRef.current
    if (resolvedRef.current) {
      return
    }
    resolvedRef.current = true
    pendingRef.current = null
    if (msgs.length > 0) {
      setMessages((prev) => [...msgs, ...prev])
    }
  }, [setMessages])
}
