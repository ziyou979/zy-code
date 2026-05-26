// Away summary hook 包装。
// 抽自 screens/REPL.tsx 1105-1108 的 `if (feature('AWAY_SUMMARY')) { useAwaySummary(...) }`。
// 同 useReplVoice / useReplFrustration / useReplScheduledTasks / useReplProactive 模式：
// feature() 守卫与条件 require 内聚于本模块，REPL 主体仅看到一个语义化 hook 调用。
// DCE 仍按 caller 模块独立生效（AGENTS.md 第 13 条）。

import { feature } from 'bun:bundle'
import type { Message } from '../../types/message.js'

type SetMessages = (updater: (prev: Message[]) => Message[]) => void

/* eslint-disable @typescript-eslint/no-require-imports */
const useAwaySummaryLazy: typeof import('../../hooks/useAwaySummary.js').useAwaySummary | null =
  feature('AWAY_SUMMARY') ? require('../../hooks/useAwaySummary.js').useAwaySummary : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean,
): void {
  if (feature('AWAY_SUMMARY')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() 是构建时常量，DCE 后路径稳定
    useAwaySummaryLazy!(messages, setMessages, isLoading)
  }
}
