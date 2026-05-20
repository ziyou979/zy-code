/**
 * Goal 模式 React hook。
 * 现在 /goal 通过 session-scoped Stop hook 驱动模型持续工作，
 * 不再需要 nudge 续接机制。此 hook 保留签名以兼容 REPL.tsx 调用。
 */

export type GoalModeProps = {
  /** 当前是否正在加载（查询进行中） */
  isLoading: boolean
  /** 排队命令数量 */
  queuedCommandsLength: number
  /** 是否有活跃的 JSX UI */
  hasActiveLocalJsxUI: boolean
  /** 将续接消息加入队列 */
  onQueueGoalNudge: (prompt: string) => void
}

/**
 * Goal 模式兼容 hook（no-op）。
 * Stop hook 机制已取代 nudge 续接 — 模型停止时由 Stop hook 拦截并评估条件，
 * 条件未满足则阻止停止，无需外部 nudge。
 */
export function useGoalMode(_props: GoalModeProps): void {
  // Stop hook 机制完全取代了 nudge 续接，此处为空实现
}
