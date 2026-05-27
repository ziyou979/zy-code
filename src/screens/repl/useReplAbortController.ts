// abortController state + 镜像 ref。
// 抽自 screens/REPL.tsx 712-716。
//
// 状态由 React 跟踪（cancelRequestProps.abortSignal、键绑定的
// canCancelRunningTask 派生都需要响应式订阅），同时持有一个 ref 给
// REPL bridge 在远程中断到达时同步读取当前 controller 然后中止。
// 每次 state 写入都顺带把 ref 同步到最新值，避免 ref 指向过时实例。

import { useRef, useState } from 'react'
import type React from 'react'

export type ReplAbortController = {
  abortController: AbortController | null
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  /** 远程中断/进程外路径用 ref 同步读取最新 controller */
  abortControllerRef: React.MutableRefObject<AbortController | null>
}

export function useReplAbortController(): ReplAbortController {
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  abortControllerRef.current = abortController
  return { abortController, setAbortController, abortControllerRef }
}
