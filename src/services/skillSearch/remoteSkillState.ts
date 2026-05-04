/**
 * Gets the current state of remote skill loading.
 * This is a stub implementation for external builds.
 */
export function getRemoteSkillState(): {
  isLoading: boolean
  error: string | null
} {
  // Stub: returns default state in external builds
  return {
    isLoading: false,
    error: null,
  }
}

/**
 * Resets the remote skill state.
 * This is a stub implementation for external builds.
 */
export function resetRemoteSkillState(): void {
  // Stub: no-op in external builds
}

/** 去除远程技能名称的规范前缀 */
export function stripCanonicalPrefix(name: string): string {
  return name
}

/** 获取已发现的远程技能元数据 */
export function getDiscoveredRemoteSkill(_slug: string): { url?: string } | undefined {
  return undefined
}
