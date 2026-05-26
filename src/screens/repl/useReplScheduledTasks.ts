// 来自 .zy/scheduled_tasks.json 的计划任务（CronCreate/Delete/List）。
// 抽自 screens/REPL.tsx 的 feature('AGENT_TRIGGERS') 条件 require + 调用块。
//
// 与 useReplVoice / useReplFrustration 同模式：feature() 守卫与条件 require 内聚，
// REPL 主体不再持有 feature() 调用，调用方仅看到一个语义化 hook。
//
// 注意：原文件中 if (feature('AGENT_TRIGGERS')) 内的 hook 调用通过 build-time DCE
// 保证同一份构建内 hook 调用顺序稳定（feature() 是常量）。本模块沿用同形态，
// 把 if-feature-call 移到 hook 内部即可，DCE 仍按 caller 模块独立生效（AGENTS.md 第 13 条）。

import { feature } from 'bun:bundle'
import type React from 'react'
import type { Message } from '../../types/message.js'

export type UseReplScheduledTasksParams = {
  isLoading: boolean
  /** 一次性快照：来自 store.getState().kairosEnabled，main.tsx 初始化后不再变化 */
  assistantMode: boolean
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

/* eslint-disable @typescript-eslint/no-require-imports */
const useScheduledTasksLazy:
  | typeof import('../../hooks/useScheduledTasks.js').useScheduledTasks
  | null = feature('AGENT_TRIGGERS')
  ? require('../../hooks/useScheduledTasks.js').useScheduledTasks
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplScheduledTasks(params: UseReplScheduledTasksParams): void {
  // Assistant 模式绕过 isLoading 门控（主动 tick → Sleep → tick 循环否则会饿死调度器）。
  // zy_kairos_cron 运行时门控在 useScheduledTasks 的 effect 内部检查（不在此处），
  // 因为将 hook 调用包装在动态条件中会破坏 rules-of-hooks —— 这里只受 build-time
  // feature() 门控，DCE 后路径稳定。
  if (feature('AGENT_TRIGGERS')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() 是构建时常量，DCE 后路径稳定
    useScheduledTasksLazy!(params)
  }
}
