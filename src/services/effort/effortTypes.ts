export const PERSISTABLE_EFFORT_LEVELS = [
  'off',
  'on',
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'ultra',
] as const

export type PersistableEffortLevel = (typeof PERSISTABLE_EFFORT_LEVELS)[number]
export type EffortLevel = PersistableEffortLevel | 'orchestrate'
