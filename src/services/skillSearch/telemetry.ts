/**
 * Logs a skill search event for telemetry.
 * This is a stub implementation for external builds.
 */
export function logSkillSearchEvent(eventName: string, metadata: Record<string, unknown>): void {
  // Stub: no-op in external builds
}

/**
 * Logs a skill usage event for telemetry.
 * This is a stub implementation for external builds.
 */
export function logSkillUsageEvent(skillId: string, metadata: Record<string, unknown>): void {
  // Stub: no-op in external builds
}

/** 记录远程技能加载事件 */
export function logRemoteSkillLoaded(params: {
  slug: string
  cacheHit?: boolean
  latencyMs?: number
  urlScheme?: string
  error?: string
  fileCount?: number
  totalBytes?: number
  fetchMethod?: string
}): void {
  // Stub: no-op in external builds
}
