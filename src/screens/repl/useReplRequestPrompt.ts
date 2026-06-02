// requestPrompt curried 工厂：(title, summary) → (request) → Promise<response>。
// 抽自 screens/REPL.tsx 2288-2304。
//
// 由 getToolUseContext 在 feature('HOOK_PROMPTS') 守卫下传入；hook 体内通过
// 把 { request, title, toolInputSummary, resolve, reject } 推入 promptQueue
// 来挂起回答 — 用户在 PromptInputDialog 选择后由 setPromptQueue(([_, ...tail]) => tail)
// 出队并调用 resolve/reject。
//
// 仅依赖 setPromptQueue 一个 setter，无其它耦合。

import type React from 'react'
import { useCallback } from 'react'
import type { PromptRequest, PromptResponse } from '../../types/hooks/index.js'

export type PromptQueueItem = {
  request: PromptRequest
  title: string
  toolInputSummary?: string | null
  resolve: (response: PromptResponse) => void
  reject: (error: Error) => void
}

export type RequestPromptFactory = (
  title: string,
  toolInputSummary?: string | null,
) => (request: PromptRequest) => Promise<PromptResponse>

export function useReplRequestPrompt(
  setPromptQueue: React.Dispatch<React.SetStateAction<PromptQueueItem[]>>,
): RequestPromptFactory {
  return useCallback(
    (title, toolInputSummary) => (request) =>
      new Promise<PromptResponse>((resolve, reject) => {
        setPromptQueue((prev) => [...prev, { request, title, toolInputSummary, resolve, reject }])
      }),
    [setPromptQueue],
  )
}
