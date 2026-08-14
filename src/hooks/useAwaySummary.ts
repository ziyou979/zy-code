import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { getTerminalFocusState, subscribeTerminalFocus } from '../ink/terminalFocusState.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { generateAwaySummary } from '../services/awaySummary.js'
import type { Message } from '../types/message.js'
import { createAwaySummaryMessage } from '../services/messages/./constructors.js'

const BLUR_DELAY_MS = 5 * 60_000

type SetMessages = (updater: (prev: Message[]) => Message[]) => void

function hasSummarySinceLastUserTurn(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user' && !m.isMeta && !m.isCompactSummary) {
      return false
    }
    if (m.type === 'system' && m.subtype === 'away_summary') {
      return true
    }
  }
  return false
}

/**
 * 终端失焦 5 分钟后追加“离开期间”摘要消息。仅在以下条件同时满足时触发：
 * (a) 失焦已满 5 分钟；(b) 当前没有进行中的轮次；
 * (c) 最近一条用户消息之后尚无 away_summary。
 *
 * 焦点状态为 'unknown'（终端不支持 DECSET 1004）时不执行操作。
 */
export function useAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  const isLoadingRef = useRef(isLoading)
  const pendingRef = useRef(false)
  const generateRef = useRef<(() => Promise<void>) | null>(null)

  messagesRef.current = messages
  isLoadingRef.current = isLoading

  // 3P default: false
  const gbEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_sedge_lantern', false)

  useEffect(() => {
    if (!feature('AWAY_SUMMARY')) {
      return
    }
    if (!gbEnabled) {
      return
    }

    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    function abortInFlight(): void {
      abortRef.current?.abort()
      abortRef.current = null
    }

    async function generate(): Promise<void> {
      pendingRef.current = false
      if (hasSummarySinceLastUserTurn(messagesRef.current)) {
        return
      }
      abortInFlight()
      const controller = new AbortController()
      abortRef.current = controller
      const text = await generateAwaySummary(messagesRef.current, controller.signal)
      if (controller.signal.aborted || text === null) {
        return
      }
      setMessages((prev) => [...prev, createAwaySummaryMessage(text)])
    }

    function onBlurTimerFire(): void {
      timerRef.current = null
      if (isLoadingRef.current) {
        pendingRef.current = true
        return
      }
      void generate()
    }

    function onFocusChange(): void {
      const state = getTerminalFocusState()
      if (state === 'blurred') {
        clearTimer()
        timerRef.current = setTimeout(onBlurTimerFire, BLUR_DELAY_MS)
      } else if (state === 'focused') {
        clearTimer()
        abortInFlight()
        pendingRef.current = false
      }
      // 'unknown' → no-op
    }

    const unsubscribe = subscribeTerminalFocus(onFocusChange)
    // 处理 effect 挂载时终端已经失焦的情况
    onFocusChange()
    generateRef.current = generate

    return () => {
      unsubscribe()
      clearTimer()
      abortInFlight()
      generateRef.current = null
    }
  }, [gbEnabled, setMessages])

  // 定时器在轮次中途触发时，若结束后仍失焦，则在轮次结束时触发
  useEffect(() => {
    if (isLoading) {
      return
    }
    if (!pendingRef.current) {
      return
    }
    if (getTerminalFocusState() !== 'blurred') {
      return
    }
    void generateRef.current?.()
  }, [isLoading])
}
