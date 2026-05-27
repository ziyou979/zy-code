// REPL loading + 计时 refs 收敛。
// 抽自 screens/REPL.tsx 757-822：
// - isExternalLoading useState：本地 queryGuard 之外的 loading 来源
//   （remote session / 前台后台任务）；远程 hasInitialPrompt 时初始化为 true
// - isLoading 派生：isQueryActive || isExternalLoading（只读，无 setter）
// - 三个 timing refs：loadingStartTimeRef / totalPausedMsRef / pauseStartTimeRef
//   由 SpinnerWithVerb 每帧读取计算 elapsed，避免 useInterval 触发 REPL 重渲染
// - resetTimingRefs：把三个 ref 写回起始态
// - 在 render 期间执行的 wasQueryActiveRef 守卫：isQueryActive 从 false→true
//   转换时同帧重置 timing refs（INC-4549，否则 spinner 读到 0 计算出 ~56 年）
// - setIsExternalLoading wrapper：value=true 时同步 resetTimingRefs，
//   保证纯远程会话也有正确 elapsed 起点
//
// wasQueryActiveRef 内化于 hook（外部无需读取）；其余 6 项作为返回值暴露。

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import type { QueryGuard } from '../../utils/QueryGuard.js'

export type ReplLoading = {
  isQueryActive: boolean
  isLoading: boolean
  isExternalLoading: boolean
  setIsExternalLoading: (value: boolean) => void
  resetTimingRefs: () => void
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
}

export function useReplLoading(
  queryGuard: QueryGuard,
  initialExternalLoading: boolean,
): ReplLoading {
  // 订阅 guard — dispatching 或 running 期间为 true。本地查询的唯一真实来源。
  const isQueryActive = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)

  const [isExternalLoading, setIsExternalLoadingRaw] = useState(initialExternalLoading)
  const isLoading = isQueryActive || isExternalLoading

  const loadingStartTimeRef = useRef<number>(0)
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)

  const resetTimingRefs = useCallback(() => {
    loadingStartTimeRef.current = Date.now()
    totalPausedMsRef.current = 0
    pauseStartTimeRef.current = null
  }, [])

  // isQueryActive false→true 的同帧重置：queryGuard.reserve() 在 onQuery
  // try 块的 ref 重置之前就触发，期间 React 用 loadingStartTimeRef=0 渲染
  // spinner（≈ 56 年）。在 render 中跑此守卫，与首次显示 spinner 的渲染同步。
  const wasQueryActiveRef = useRef(false)
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs()
  }
  wasQueryActiveRef.current = isQueryActive

  // 远程/前台任务的 setter：value=true 时同步重置 timing refs，否则
  // 纯远程会话 spinner 读到 0 起点 → elapsed ≈ 56 年。
  const setIsExternalLoading = useCallback(
    (value: boolean) => {
      setIsExternalLoadingRaw(value)
      if (value) {
        resetTimingRefs()
      }
    },
    [resetTimingRefs],
  )

  return {
    isQueryActive,
    isLoading,
    isExternalLoading,
    setIsExternalLoading,
    resetTimingRefs,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
  }
}
