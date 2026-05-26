// Proactive / Loop mode hook 包装。
// 抽自 screens/REPL.tsx 的 useProactive 条件 require + 调用块。
// 同 useReplVoice / useReplFrustration / useReplScheduledTasks 模式：feature() 守卫
// 与条件 require 内聚于本模块，REPL 主体直接调用 useReplProactive。
//
// 与 cli/lazyModules.ts 中的 proactiveModule 共享同一份 feature 门控
// （PROACTIVE 或 KAIROS 任一启用），DCE 仍按 caller 模块独立生效（AGENTS.md 第 13 条）。

import { feature } from 'bun:bundle'

export type UseReplProactiveParams = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

/* eslint-disable @typescript-eslint/no-require-imports */
const useProactiveLazy: typeof import('../../proactive/useProactive.js').useProactive | null =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../../proactive/useProactive.js').useProactive
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Loop mode 自动 tick（通过 /job 命令启用）。
 * 仅在 PROACTIVE / KAIROS 构建中生效，外部构建经 DCE 完全消除。
 *
 * 注意：DCE 后 useProactiveLazy 要么始终非空、要么始终为 null —— 同一份构建内
 * hook 调用顺序稳定，rules-of-hooks 不会真正触发。
 */
export function useReplProactive(params: UseReplProactiveParams): void {
  if (feature('PROACTIVE') || feature('KAIROS')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() 是构建时常量，DCE 后路径稳定
    useProactiveLazy!(params)
  }
}
