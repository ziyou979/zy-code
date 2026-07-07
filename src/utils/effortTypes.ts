/**
 * Effort 档位常量与类型。
 * 单独抽离以打破 effort.ts ↔ providers.ts 之间的循环依赖。
 */

/** 可持久化的 effort 档位（不含 orchestrate — 那是会话模式标记，不是独立档位） */
export const PERSISTABLE_EFFORT_LEVELS = [
  'off',
  'on', // 思考开启（无特定强度，不走 provider 映射）
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'ultra', // 最强思考 + 回传 thinking 块（preserve: optional 时自动追加）
] as const

export type PersistableEffortLevel = (typeof PERSISTABLE_EFFORT_LEVELS)[number]
export type EffortLevel = PersistableEffortLevel | 'orchestrate'
