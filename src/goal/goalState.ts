/**
 * 目标驱动模式状态管理。
 * 状态现在存储在 AppState.activeGoal 中（由 /goal 命令的 Stop hook 机制驱动）。
 * 本模块保留为兼容层，供 useGoalMode.ts 使用。
 */

export interface GoalSnapshot {
  active: boolean
  paused: boolean
  description: string
  turnCount: number
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  cost: number
}

/**
 * 目标模式是否激活。
 * 兼容旧接口 — 实际状态由 AppState.activeGoal 管理。
 * 此函数现在始终返回 false，因为 Stop hook 机制不依赖此检查。
 */
export function isGoalActive(): boolean {
  return false
}

/** 目标模式是否暂停（Stop hook 机制下不再使用） */
export function isGoalPaused(): boolean {
  return false
}

/** 递增目标轮次计数（Stop hook 机制下不再使用） */
export function incrementGoalTurn(): void {
  // no-op: iterations 由 Stop hook 评估时自动递增（写入 AppState.activeGoal.iterations）
}

/** 获取目标模式完整快照（兼容旧接口） */
export function getGoalState(): GoalSnapshot {
  return {
    active: false,
    paused: false,
    description: '',
    turnCount: 0,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  }
}
